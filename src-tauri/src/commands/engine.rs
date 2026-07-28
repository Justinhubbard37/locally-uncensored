// P1 — Built-in inference engine (bundled llama.cpp `llama-server`).
//
// The whole point of 2.5.7's "onboarding without external providers" is that
// the app ships its own inference engine and never *requires* Ollama / LM
// Studio again. `llama-server` speaks an OpenAI-compatible API, so the
// existing `OpenAIProvider` + `proxy_localhost_stream_chunked` path drives it
// unchanged — this module owns only the *lifecycle* (spawn / health-wait /
// stop / model-swap) of the sidecar process, mirroring `start_ollama`.
//
// One model per process: `llama-server` loads a single GGUF, so a model swap
// is a stop→start with a new `-m` (Ollama-like, ~1-3 s). The child handle
// lives in `AppState.bundled_engine` and is killed in `shutdown_subprocesses`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::state::{AppState, BundledEngine};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Default loopback port for the managed chat engine. Matches the `builtin`
/// preset base URL on the frontend (`http://127.0.0.1:8127/v1`).
pub const DEFAULT_ENGINE_PORT: u16 = 8127;

/// Default loopback port for the managed EMBEDDINGS server (P5). Separate
/// process/port from the chat engine so Document-Chat/RAG can embed while a
/// chat model stays loaded. Matches `embedBaseUrl()` on the frontend
/// (`http://127.0.0.1:8128/v1`).
pub const DEFAULT_EMBED_PORT: u16 = 8128;

/// How long to wait for `/health` to flip to 200 after spawn. A cold GGUF
/// load (mmap + Metal warm-up) on a big model can take a while on a slow disk;
/// 60 s is comfortably above a normal 1-3 s load without hanging forever on a
/// binary that never comes up.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);

// ── Pure helpers (unit-tested without a real binary) ─────────────────────────

/// Sidecar file name Tauri produces from `externalBin: ["bin/llama-server"]`
/// inside the bundled app (target-triple suffix stripped, `.exe` on Windows).
pub(crate) fn sidecar_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

/// Rust host target-triple, used to locate the dev-time sidecar produced by
/// `scripts/build-llama.sh` (`bin/llama-server-<triple>[.exe]`). mac-first for
/// 2.5.7; win/linux triples are here so P6 doesn't need to touch this.
pub(crate) fn host_target_triple() -> String {
    let arch = std::env::consts::ARCH; // "aarch64" | "x86_64" | ...
    match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        _ => format!("{arch}-unknown-linux-gnu"),
    }
}

/// Expert tuning for the chat engine, settable from the app's Built-in Engine
/// settings. `Default` reproduces the exact argv the app has always used, so
/// an absent/partial tuning is never a behavior change. Values are whitelisted
/// in `build_server_args` — an unknown string falls back to the default flag
/// (settings files are user-editable; never pass them through verbatim).
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineTuning {
    /// Context window (`--ctx-size`). 0 is NOT forwarded as llama-server's
    /// "use model default" — a 128k-trained model would allocate a huge KV
    /// cache unprompted; 0/absent means our 8192 default.
    pub ctx: u32,
    /// Flash Attention: "auto" (binary default, omitted), "on", "off".
    pub flash_attn: String,
    /// KV cache quantization for K / V: "f16" (default, omitted), "bf16",
    /// "q8_0", "q4_0". Quantized V requires Flash Attention in llama.cpp.
    pub cache_type_k: String,
    pub cache_type_v: String,
    /// CPU threads for generation. <=0 = auto (omitted).
    pub threads: i32,
    /// GPU layers to offload. <0 = all (999, today's behavior); >=0 explicit
    /// (0 = CPU-only is a valid expert choice on RAM-starved boxes).
    pub gpu_layers: i32,
    /// Pin model in RAM (`--mlock`).
    pub mlock: bool,
    /// Disable mmap (`--no-mmap`): slower load, fewer pageouts.
    pub no_mmap: bool,
}

impl Default for EngineTuning {
    fn default() -> Self {
        Self {
            ctx: 8192,
            flash_attn: "auto".into(),
            cache_type_k: "f16".into(),
            cache_type_v: "f16".into(),
            threads: -1,
            gpu_layers: -1,
            mlock: false,
            no_mmap: false,
        }
    }
}

/// KV cache types this build of llama-server accepts and we consider sane.
const KV_CACHE_TYPES: &[&str] = &["f16", "bf16", "q8_0", "q4_0"];

/// The context size actually passed to the server (`tuning.ctx`, with 0
/// falling back to the 8192 default — see `EngineTuning::ctx`).
pub(crate) fn effective_ctx(tuning: &EngineTuning) -> u32 {
    if tuning.ctx == 0 { 8192 } else { tuning.ctx }
}

/// Build the `llama-server` argv for a chat engine. `-ngl 999` offloads every
/// layer to the GPU (Metal on mac); llama-server clamps to the real layer
/// count, so an over-large value is the idiomatic "all layers" request.
/// Default tuning yields exactly the legacy argv (pinned by regression test).
pub(crate) fn build_server_args(model_path: &str, tuning: &EngineTuning, port: u16) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-m".into(),
        model_path.into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--ctx-size".into(),
        effective_ctx(tuning).to_string(),
        "-ngl".into(),
        if tuning.gpu_layers < 0 {
            "999".into()
        } else {
            tuning.gpu_layers.to_string()
        },
    ];
    if matches!(tuning.flash_attn.as_str(), "on" | "off") {
        args.push("-fa".into());
        args.push(tuning.flash_attn.clone());
    }
    if tuning.cache_type_k != "f16" && KV_CACHE_TYPES.contains(&tuning.cache_type_k.as_str()) {
        args.push("-ctk".into());
        args.push(tuning.cache_type_k.clone());
    }
    if tuning.cache_type_v != "f16" && KV_CACHE_TYPES.contains(&tuning.cache_type_v.as_str()) {
        args.push("-ctv".into());
        args.push(tuning.cache_type_v.clone());
    }
    if tuning.threads > 0 {
        args.push("-t".into());
        args.push(tuning.threads.to_string());
    }
    if tuning.mlock {
        args.push("--mlock".into());
    }
    if tuning.no_mmap {
        args.push("--no-mmap".into());
    }
    args
}

/// Build the `llama-server` argv for the EMBEDDINGS server (P5). `--embeddings`
/// switches llama-server into pooled-embedding mode so `/v1/embeddings`
/// returns vectors instead of chat completions. `--pooling mean` matches how
/// nomic/bge embedding GGUFs are meant to be pooled. `-ngl 999` offloads all
/// layers (Metal on mac); embedding models are tiny so this is cheap.
pub(crate) fn build_embed_args(model_path: &str, port: u16) -> Vec<String> {
    vec![
        "-m".into(),
        model_path.into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--embeddings".into(),
        "--pooling".into(),
        "mean".into(),
        "-ngl".into(),
        "999".into(),
    ]
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct BundledModel {
    /// File name without the `.gguf` extension — the id the frontend shows and
    /// passes back to `swap_bundled_model`.
    pub name: String,
    /// Absolute path to the GGUF file.
    pub path: String,
    /// File size in bytes (0 if it couldn't be stat-ed).
    pub size: u64,
}

/// Scan a directory (non-recursive) for `*.gguf` files. Case-insensitive on
/// the extension so `Model.GGUF` from a manual copy still shows up. Sorted by
/// name for a stable UI ordering. Missing dir → empty list (not an error): a
/// fresh install has no models yet.
pub(crate) fn scan_gguf_models(dir: &Path) -> Vec<BundledModel> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_gguf = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("gguf"))
            .unwrap_or(false);
        if !is_gguf {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(BundledModel {
            name,
            path: path.to_string_lossy().to_string(),
            size,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// App-owned models directory for the built-in engine:
/// `{data_dir}/Locally Uncensored/models`. Created on demand so the first
/// download / scan just works on a fresh box. This is the same path
/// `detect_model_path("builtin")` returns.
pub fn builtin_models_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("Cannot resolve app data directory")?;
    let dir = base.join("Locally Uncensored").join("models");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Create built-in models dir: {e}"))?;
    Ok(dir)
}

// ── Sidecar resolution ───────────────────────────────────────────────────────

/// Locate the bundled `llama-server` binary. Prod: next to the main
/// executable (where Tauri copies `externalBin`). Dev: the target-triple
/// artifact `scripts/build-llama.sh` drops into `src-tauri/bin/`.
fn resolve_engine_binary(app: &AppHandle) -> Option<PathBuf> {
    // 1. Bundled: same dir as the running app binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(sidecar_binary_name());
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // 2. Resource dir (belt-and-suspenders for platforms that stage it there).
    if let Ok(res) = app.path().resource_dir() {
        let candidate = res.join(sidecar_binary_name());
        if candidate.exists() {
            return Some(candidate);
        }
    }

    // 3. Dev: src-tauri/bin/llama-server-<triple>[.exe]. `tauri dev` runs the
    //    binary from target/debug, so walk up to the manifest dir.
    let triple = host_target_triple();
    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let dev_name = format!("llama-server-{triple}{suffix}");
    let mut dev_candidates: Vec<PathBuf> = Vec::new();
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        dev_candidates.push(PathBuf::from(&manifest).join("bin").join(&dev_name));
    }
    if let Ok(cwd) = std::env::current_dir() {
        dev_candidates.push(cwd.join("src-tauri").join("bin").join(&dev_name));
        dev_candidates.push(cwd.join("bin").join(&dev_name));
    }
    dev_candidates.into_iter().find(|p| p.exists())
}

// ── Health probe ─────────────────────────────────────────────────────────────

fn engine_healthy(port: u16) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(400))
        .build()
        .ok()
        .and_then(|c| c.get(format!("http://127.0.0.1:{port}/health")).send().ok())
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// The last `max` non-empty lines of a sidecar's stderr, for an error message.
fn tail_lines(text: &str, max: usize) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let start = lines.len().saturating_sub(max);
    lines[start..].join("\n")
}

/// Health budget scaled to the GGUF on disk: base 60s + 4s per GiB, capped
/// at 10 minutes. A 0.5 GB model keeps the old 60s; a 40 GB one gets ~220s —
/// big models legitimately need minutes on a cold first load, and a fixed
/// 60s turned that into a false "did not become healthy" (ENG-4).
fn health_timeout_for_bytes(bytes: u64) -> Duration {
    let gb = (bytes / 1_073_741_824).min(1024) as u32;
    (HEALTH_TIMEOUT + Duration::from_secs(4) * gb).min(Duration::from_secs(600))
}

fn health_timeout_for(model_path: &str) -> Duration {
    std::fs::metadata(model_path)
        .map(|m| health_timeout_for_bytes(m.len()))
        .unwrap_or(HEALTH_TIMEOUT)
}

/// Block until `/health` returns 200 or `timeout` elapses (callers scale the
/// budget to the model size via `health_timeout_for`). Returns `Ok(())` on
/// ready, `Err` with a hint on timeout so the UI can surface a real message
/// instead of a silent hang.
fn wait_for_health(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if engine_healthy(port) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Err(format!(
        "Built-in engine did not become healthy on port {port} within {}s (the budget scales with model size — huge GGUFs can take minutes on a cold first load)",
        timeout.as_secs()
    ))
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Start (or reuse) the managed chat engine for `model_path`. Idempotent: if
/// the same model is already loaded and healthy, returns `already_running`.
/// A different model in flight is stopped first (single-process engine).
/// Freeze fix: loading a GGUF takes seconds to a minute, and `wait_for_health`
/// blocks for all of it. As a plain sync `#[command]` that ran on the Tauri main
/// thread, so the whole window sat frozen while the built-in engine started —
/// the same class already fixed for the ComfyUI probes and the custom-node
/// install. The blocking half runs on the blocking pool; the JS caller still
/// awaits exactly as before.
#[tauri::command]
pub async fn start_bundled_engine(
    app: AppHandle,
    model_path: String,
    tuning: Option<EngineTuning>,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_bundled_engine_blocking(&app, &state, model_path, tuning, port)
    })
    .await
    .map_err(|e| format!("Engine start task failed to run: {e}"))?
}

fn start_bundled_engine_blocking(
    app: &AppHandle,
    state: &State<'_, AppState>,
    model_path: String,
    tuning: Option<EngineTuning>,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let _gate = crate::commands::process::start_gate(&crate::commands::process::ENGINE_START);
    let tuning = tuning.unwrap_or_default();
    let port = port.unwrap_or(DEFAULT_ENGINE_PORT);

    if !Path::new(&model_path).exists() {
        return Err(format!("Model file not found: {model_path}"));
    }

    let desired_args = build_server_args(&model_path, &tuning, port);

    // Already serving this exact argv and healthy → no-op. The argv is the
    // idempotence key: a ctx/KV-quant/flash-attn change restarts the server,
    // an identical request reuses the running process.
    {
        let guard = state.bundled_engine.lock().unwrap();
        if let Some(engine) = guard.as_ref() {
            if engine.args == desired_args && engine_healthy(engine.port) {
                return Ok(serde_json::json!({
                    "status": "already_running",
                    "port": engine.port,
                    "model_path": engine.model_path,
                    "ctx": engine.ctx,
                }));
            }
        }
    }

    // Different model (or dead) → stop the old process before spawning.
    stop_engine_locked(state);

    // Mirror image of the Create-tab handoff: a render leaves ComfyUI's
    // checkpoint cached in VRAM (`includeComfyui:false` keeps it warm between
    // runs). On a single-GPU box the returning chat engine then fights that
    // cache for memory — llama-server with `-ngl 999` loses as a CUDA OOM
    // (RTX 5080 field report: ACE-Step → chat = crash until app restart). Ask
    // ComfyUI to drop its cache first; best-effort no-op when it isn't running.
    if crate::commands::process::free_comfyui_memory() {
        println!("[Engine] asked ComfyUI to free VRAM before engine start");
    }

    let binary = resolve_engine_binary(app).ok_or_else(|| {
        format!(
            "Bundled engine binary not found ({}). Run scripts/build-llama.sh to produce the sidecar.",
            sidecar_binary_name()
        )
    })?;

    println!("[Engine] Starting built-in llama-server on port {port} — {model_path}");
    let mut cmd = Command::new(&binary);
    cmd.args(&desired_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // llama-server writes the REASON a start fails here: a GGUF it refuses,
        // a quant this build has no kernel for, a port already taken, too little
        // VRAM. Sending it to /dev/null left the user with "did not become
        // healthy", which names no cause at all. Drained on its own thread so
        // the pipe can never fill and stall the server (see commands/shell.rs).
        .stderr(Stdio::piped());
    // Forward the user's GPU pick (CUDA/HIP/OneAPI) exactly like start_ollama;
    // no-op in the default "auto" mode. On mac this is inert (Metal).
    if let Ok(sel) = state.gpu_selection.lock() {
        crate::commands::gpu::apply_gpu_env(&mut cmd, &sel);
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn bundled engine: {e}"))?;
    let diagnostics = child.stderr.take().map(super::shell::drain);

    *state.bundled_engine.lock().unwrap() = Some(BundledEngine {
        child,
        model_path: model_path.clone(),
        port,
        ctx: Some(effective_ctx(&tuning)),
        args: desired_args,
    });

    // Wait for the model to load. On failure, reap the child so we don't leave
    // a zombie half-loaded server behind.
    if let Err(e) = wait_for_health(port, health_timeout_for(&model_path)) {
        let why = diagnostics
            .map(|(buf, _)| tail_lines(&super::shell::captured_text(&buf), 12))
            .unwrap_or_default();
        stop_engine_locked(state);
        return Err(if why.is_empty() { e } else { format!("{e}\n\n{why}") });
    }

    println!("[Engine] Built-in engine healthy on port {port}");
    Ok(serde_json::json!({
        "status": "started",
        "port": port,
        "model_path": model_path,
        "ctx": effective_ctx(&tuning),
    }))
}

/// Stop the managed engine, killing the child. Idempotent.
#[tauri::command]
pub async fn stop_bundled_engine(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // kill + wait on a server that is mid-load is not instant.
        let state = app.state::<AppState>();
        let was_running = stop_engine_locked(&state);
        serde_json::json!({ "status": if was_running { "stopped" } else { "idle" } })
    })
    .await
    .map_err(|e| format!("Engine stop task failed to run: {e}"))
}

/// Report whether the engine is up, which model, on which port, and a live
/// health probe. `running` reflects the child handle; `healthy` the HTTP probe
/// (they diverge briefly during cold load).
/// Async because of the health probe: it is a blocking HTTP call with a 400 ms
/// timeout, and the UI polls this. On the main thread that was a stutter on
/// every poll and a 400 ms stall whenever the engine was starting or gone.
#[tauri::command]
pub async fn bundled_engine_status(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let probe = {
            let guard = state.bundled_engine.lock().unwrap();
            guard.as_ref().map(|e| (e.port, e.model_path.clone(), e.ctx))
        };
        match probe {
            Some((port, model_path, ctx)) => serde_json::json!({
                "running": true,
                "healthy": engine_healthy(port),
                "port": port,
                "model_path": model_path,
                "ctx": ctx,
            }),
            None => serde_json::json!({
                "running": false,
                "healthy": false,
                "port": DEFAULT_ENGINE_PORT,
                "model_path": null,
                "ctx": null,
            }),
        }
    })
    .await
    .map_err(|e| format!("Engine status task failed to run: {e}"))
}

/// Swap the loaded model: stop the current process and start `model_path` on
/// the same port. Thin wrapper over `start_bundled_engine` (which already
/// stops a mismatched model), kept as a distinct command so the intent reads
/// clearly at the call site and the port is preserved.
#[tauri::command]
pub async fn swap_bundled_model(
    app: AppHandle,
    model_path: String,
    tuning: Option<EngineTuning>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let port = state
            .bundled_engine
            .lock()
            .unwrap()
            .as_ref()
            .map(|e| e.port)
            .unwrap_or(DEFAULT_ENGINE_PORT);
        start_bundled_engine_blocking(&app, &state, model_path, tuning, Some(port))
    })
    .await
    .map_err(|e| format!("Engine swap task failed to run: {e}"))?
}

/// List `*.gguf` files in the built-in models dir, marking the one currently
/// loaded. Used by the frontend instead of `/v1/models` (which would only
/// report the single loaded model).
// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn list_bundled_models(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        list_bundled_models_blocking(&state)
    })
    .await
    .map_err(|e| format!("list_bundled_models task: {e}"))?
}

fn list_bundled_models_blocking(state: &AppState) -> Result<serde_json::Value, String> {
    let dir = builtin_models_dir()?;
    let loaded = state
        .bundled_engine
        .lock()
        .unwrap()
        .as_ref()
        .map(|e| e.model_path.clone());
    let models: Vec<serde_json::Value> = scan_gguf_models(&dir)
        .into_iter()
        .map(|m| {
            let is_loaded = loaded.as_deref() == Some(m.path.as_str());
            serde_json::json!({
                "name": m.name,
                "path": m.path,
                "size": m.size,
                "loaded": is_loaded,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "dir": dir.to_string_lossy(),
        "models": models,
    }))
}

/// Kill the managed engine child if present. Returns whether one was running.
/// Takes the state lock internally; callers must not already hold it.
pub(crate) fn stop_engine_locked(state: &AppState) -> bool {
    let mut guard = state.bundled_engine.lock().unwrap();
    if let Some(mut engine) = guard.take() {
        let _ = engine.child.kill();
        let _ = engine.child.wait();
        println!("[Engine] Built-in engine stopped (port {})", engine.port);
        true
    } else {
        false
    }
}

// ── Embeddings server (P5) ────────────────────────────────────────────────────
//
// A second `llama-server` in `--embeddings` mode on its own port. Same
// lifecycle shape as the chat engine (spawn → health-wait → stop), reusing
// `resolve_engine_binary` / `wait_for_health` / `engine_healthy` (all
// port-generic). Document-Chat / RAG POST to `/v1/embeddings` on this port
// instead of Ollama's `/api/embed`, so the RAG path is Ollama-free.

/// Start (or reuse) the managed embeddings server for `model_path`. Idempotent
/// for the same model + healthy. A different embed model in flight is stopped
/// first (single-process server).
#[tauri::command]
pub async fn start_bundled_embed(
    app: AppHandle,
    model_path: String,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_bundled_embed_blocking(&app, &state, model_path, port)
    })
    .await
    .map_err(|e| format!("Embeddings start task failed to run: {e}"))?
}

fn start_bundled_embed_blocking(
    app: &AppHandle,
    state: &State<'_, AppState>,
    model_path: String,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let _gate = crate::commands::process::start_gate(&crate::commands::process::EMBED_START);
    let port = port.unwrap_or(DEFAULT_EMBED_PORT);

    if !Path::new(&model_path).exists() {
        return Err(format!("Embedding model file not found: {model_path}"));
    }

    // Already serving this exact model and healthy → no-op.
    {
        let guard = state.bundled_embed.lock().unwrap();
        if let Some(embed) = guard.as_ref() {
            if embed.model_path == model_path && engine_healthy(embed.port) {
                return Ok(serde_json::json!({
                    "status": "already_running",
                    "port": embed.port,
                    "model_path": embed.model_path,
                }));
            }
        }
    }

    stop_embed_locked(state);

    let binary = resolve_engine_binary(app).ok_or_else(|| {
        format!(
            "Bundled engine binary not found ({}). Run scripts/build-llama.sh to produce the sidecar.",
            sidecar_binary_name()
        )
    })?;

    println!("[Engine] Starting built-in embeddings server on port {port} — {model_path}");
    let mut cmd = Command::new(&binary);
    cmd.args(build_embed_args(&model_path, port))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Ok(sel) = state.gpu_selection.lock() {
        crate::commands::gpu::apply_gpu_env(&mut cmd, &sel);
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn embeddings server: {e}"))?;
    let diagnostics = child.stderr.take().map(super::shell::drain);

    *state.bundled_embed.lock().unwrap() = Some(BundledEngine {
        child,
        model_path: model_path.clone(),
        port,
        // No --ctx-size on the embed server; args recorded for symmetry (its
        // idempotence check stays model_path-based, embeds have no tuning).
        ctx: None,
        args: build_embed_args(&model_path, port),
    });

    if let Err(e) = wait_for_health(port, health_timeout_for(&model_path)) {
        let why = diagnostics
            .map(|(buf, _)| tail_lines(&super::shell::captured_text(&buf), 12))
            .unwrap_or_default();
        stop_embed_locked(state);
        return Err(if why.is_empty() { e } else { format!("{e}\n\n{why}") });
    }

    println!("[Engine] Built-in embeddings server healthy on port {port}");
    Ok(serde_json::json!({
        "status": "started",
        "port": port,
        "model_path": model_path,
    }))
}

/// Stop the managed embeddings server, killing the child. Idempotent.
#[tauri::command]
pub async fn stop_bundled_embed(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let was_running = stop_embed_locked(&state);
        serde_json::json!({ "status": if was_running { "stopped" } else { "idle" } })
    })
    .await
    .map_err(|e| format!("Embeddings stop task failed to run: {e}"))
}

/// Report whether the embeddings server is up, which model, on which port.
#[tauri::command]
pub async fn bundled_embed_status(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // Probe OUTSIDE the lock: holding it across a blocking HTTP call made
        // every other engine command queue behind the status poll.
        let probe = {
            let guard = state.bundled_embed.lock().unwrap();
            guard.as_ref().map(|e| (e.port, e.model_path.clone()))
        };
        match probe {
            Some((port, model_path)) => serde_json::json!({
                "running": true,
                "healthy": engine_healthy(port),
                "port": port,
                "model_path": model_path,
            }),
            None => serde_json::json!({
                "running": false,
                "healthy": false,
                "port": DEFAULT_EMBED_PORT,
                "model_path": null,
            }),
        }
    })
    .await
    .map_err(|e| format!("Embeddings status task failed to run: {e}"))
}

/// Kill the managed embeddings child if present. Returns whether one was
/// running. Takes the state lock internally; callers must not already hold it.
pub(crate) fn stop_embed_locked(state: &AppState) -> bool {
    let mut guard = state.bundled_embed.lock().unwrap();
    if let Some(mut embed) = guard.take() {
        let _ = embed.child.kill();
        let _ = embed.child.wait();
        println!("[Engine] Built-in embeddings server stopped (port {})", embed.port);
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_timeout_scales_with_model_size_and_caps() {
        assert_eq!(health_timeout_for_bytes(0), Duration::from_secs(60));
        // 0.5 GiB rounds down to the 60s base.
        assert_eq!(health_timeout_for_bytes(536_870_912), Duration::from_secs(60));
        assert_eq!(health_timeout_for_bytes(8 * 1_073_741_824), Duration::from_secs(92));
        assert_eq!(health_timeout_for_bytes(40 * 1_073_741_824), Duration::from_secs(220));
        // Absurd sizes hit the 10-minute cap instead of overflowing.
        assert_eq!(health_timeout_for_bytes(u64::MAX), Duration::from_secs(600));
    }

    #[test]
    fn default_tuning_args_match_legacy_shape() {
        // Pin: absent/default tuning must produce EXACTLY the argv the app has
        // shipped since 2.5.7 — expert settings are opt-in, never a drift.
        let args = build_server_args("/models/qwen.gguf", &EngineTuning::default(), 8127);
        assert_eq!(
            args,
            vec![
                "-m", "/models/qwen.gguf",
                "--host", "127.0.0.1",
                "--port", "8127",
                "--ctx-size", "8192",
                "-ngl", "999",
            ]
        );
    }

    #[test]
    fn expert_tuning_adds_all_flags_in_stable_order() {
        let tuning = EngineTuning {
            ctx: 16384,
            flash_attn: "on".into(),
            cache_type_k: "q8_0".into(),
            cache_type_v: "q8_0".into(),
            threads: 8,
            gpu_layers: 20,
            mlock: true,
            no_mmap: true,
        };
        let args = build_server_args("/m.gguf", &tuning, 8127);
        assert_eq!(
            args,
            vec![
                "-m", "/m.gguf",
                "--host", "127.0.0.1",
                "--port", "8127",
                "--ctx-size", "16384",
                "-ngl", "20",
                "-fa", "on",
                "-ctk", "q8_0",
                "-ctv", "q8_0",
                "-t", "8",
                "--mlock",
                "--no-mmap",
            ]
        );
    }

    #[test]
    fn junk_tuning_values_fall_back_to_legacy_argv() {
        // Settings files are user-editable JSON — junk enum strings must be
        // dropped (binary defaults), never passed through to the argv.
        let tuning = EngineTuning {
            ctx: 0,
            flash_attn: "banana".into(),
            cache_type_k: "'; rm -rf /".into(),
            cache_type_v: "zzz".into(),
            threads: -4,
            gpu_layers: -1,
            mlock: false,
            no_mmap: false,
        };
        let args = build_server_args("/m.gguf", &tuning, 8127);
        assert_eq!(
            args,
            vec![
                "-m", "/m.gguf",
                "--host", "127.0.0.1",
                "--port", "8127",
                "--ctx-size", "8192",
                "-ngl", "999",
            ]
        );
    }

    #[test]
    fn gpu_layers_zero_means_cpu_only_not_all() {
        let tuning = EngineTuning { gpu_layers: 0, ..Default::default() };
        let args = build_server_args("/m.gguf", &tuning, 8127);
        let ngl = args.iter().position(|a| a == "-ngl").unwrap();
        assert_eq!(args[ngl + 1], "0");
    }

    #[test]
    fn partial_tuning_json_deserializes_with_defaults() {
        // The frontend sends partial objects ({ctx: 16384}); serde(default)
        // must fill the rest so a partial settings write never breaks starts.
        let t: EngineTuning = serde_json::from_str(r#"{"ctx":16384,"cacheTypeK":"q8_0"}"#).unwrap();
        assert_eq!(t.ctx, 16384);
        assert_eq!(t.cache_type_k, "q8_0");
        assert_eq!(t.flash_attn, "auto");
        assert_eq!(t.gpu_layers, -1);
    }

    #[test]
    fn embed_args_enable_embeddings_and_mean_pooling() {
        let args = build_embed_args("/models/nomic-embed.gguf", 8128);
        assert_eq!(
            args,
            vec![
                "-m", "/models/nomic-embed.gguf",
                "--host", "127.0.0.1",
                "--port", "8128",
                "--embeddings",
                "--pooling", "mean",
                "-ngl", "999",
            ]
        );
        // The whole point of P5: the embed server must NOT carry --ctx-size
        // (chat-only) and MUST carry --embeddings so /v1/embeddings works.
        assert!(args.iter().any(|a| a == "--embeddings"));
        assert!(!args.iter().any(|a| a == "--ctx-size"));
    }

    #[test]
    fn host_triple_is_platform_shaped() {
        let t = host_target_triple();
        if cfg!(target_os = "macos") {
            assert!(t.ends_with("-apple-darwin"), "got {t}");
        } else if cfg!(target_os = "windows") {
            assert!(t.ends_with("-pc-windows-msvc"), "got {t}");
        } else {
            assert!(t.ends_with("-unknown-linux-gnu"), "got {t}");
        }
    }

    #[test]
    fn sidecar_name_has_exe_only_on_windows() {
        let name = sidecar_binary_name();
        if cfg!(target_os = "windows") {
            assert_eq!(name, "llama-server.exe");
        } else {
            assert_eq!(name, "llama-server");
        }
    }

    #[test]
    fn scan_finds_gguf_marks_none_loaded_and_ignores_others() {
        let dir = std::env::temp_dir().join(format!("lu-engine-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("alpha.gguf"), b"x").unwrap();
        std::fs::write(dir.join("Beta.GGUF"), b"yy").unwrap();
        std::fs::write(dir.join("notes.txt"), b"zzz").unwrap();
        std::fs::write(dir.join("model.bin"), b"w").unwrap();

        let models = scan_gguf_models(&dir);
        let names: Vec<&str> = models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Beta", "alpha"]); // sorted, case-insensitive ext
        assert_eq!(models[1].size, 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_missing_dir_is_empty_not_error() {
        let dir = std::env::temp_dir().join("lu-engine-nonexistent-xyz-123");
        assert!(scan_gguf_models(&dir).is_empty());
    }
}

#[cfg(test)]
mod diag_tests {
    use super::tail_lines;

    #[test]
    fn tail_keeps_the_last_lines_and_drops_blanks() {
        let log = "loading model\n\n  error: unknown pre-tokenizer type  \nfailed to load\n\n";
        assert_eq!(
            tail_lines(log, 2),
            "error: unknown pre-tokenizer type\nfailed to load"
        );
    }

    #[test]
    fn tail_of_a_short_log_is_the_whole_log() {
        assert_eq!(tail_lines("only line", 12), "only line");
        assert_eq!(tail_lines("", 12), "");
    }
}
