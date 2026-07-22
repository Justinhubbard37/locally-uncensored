// Phase 6 — lu-bridge media sidecar (macOS Apple-Silicon MLX local media).
//
// Hard rule (David): Mac local image/video is MLX-via-`lu-bridge` ONLY, never
// ComfyUI. Rather than re-implement the MLX engine, we bundle the existing
// `lu-bridge` binary (from uselu/apps/bridge) as a managed sidecar — the same
// pattern the app already uses for `llama-server` (see `commands::engine`).
//
// The bridge binds 127.0.0.1:47711 and serves every `/cmd/:name` locally with
// NO auth (loopback bind IS the security boundary — see bridge `main.rs`). We
// spawn it headless (`LU_BRIDGE_NO_WINDOW=1`, so no second native window) and
// fully offline (`LU_REQUIRE_AUTH=0`, no cloud JWKS). The MLX image/video
// commands (`mlx_*`, `video_*`) are then reachable from the desktop frontend
// over plain localhost HTTP. The child handle lives in `AppState.media_bridge`
// and is reaped in `shutdown_subprocesses`.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};

use crate::state::AppState;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Loopback port the bridge listens on. Matches the bridge default
/// (`LU_BRIDGE_ADDR`) and the web client (`NEXT_PUBLIC_BRIDGE_URL`).
pub const BRIDGE_PORT: u16 = 47711;

/// How long to wait for `/health` after spawn. The bridge is a small Rust
/// daemon (no model load), so it comes up in well under a second — but a cold
/// first launch on a busy box can lag, hence a generous ceiling.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);

/// Bundled sidecar file name Tauri produces from `externalBin: ["bin/lu-bridge"]`
/// (target-triple suffix stripped inside the .app; `.exe` on Windows).
fn sidecar_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "lu-bridge.exe"
    } else {
        "lu-bridge"
    }
}

/// Locate the bridge binary: bundled next to the app exe, in the resource dir,
/// or the dev-time `src-tauri/bin/lu-bridge-<triple>` produced at build prep.
/// Mirrors `engine::resolve_engine_binary`.
fn resolve_bridge_binary(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(sidecar_binary_name());
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        let candidate = res.join(sidecar_binary_name());
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let triple = crate::commands::engine::host_target_triple();
    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let dev_name = format!("lu-bridge-{triple}{suffix}");
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

fn bridge_healthy(port: u16) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
        .ok()
        .and_then(|c| c.get(format!("http://127.0.0.1:{port}/health")).send().ok())
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn wait_for_bridge_health(port: u16) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < HEALTH_TIMEOUT {
        if bridge_healthy(port) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err(format!(
        "lu-bridge did not become healthy on port {port} within {}s",
        HEALTH_TIMEOUT.as_secs()
    ))
}

/// Start the bundled `lu-bridge` sidecar headless on 127.0.0.1:47711. Idempotent:
/// if it's already healthy (ours or a user-run bridge), returns `already_running`.
#[tauri::command]
pub fn start_media_bridge(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // Already serving (our child or an externally-run bridge) → no-op.
    if bridge_healthy(BRIDGE_PORT) {
        return Ok(serde_json::json!({ "status": "already_running", "port": BRIDGE_PORT }));
    }

    // A dead handle lingering from a previous crash → reap before respawn.
    stop_bridge_locked(&state);

    let binary = resolve_bridge_binary(&app).ok_or_else(|| {
        format!(
            "lu-bridge binary not found ({}). The MLX media sidecar is bundled on Apple Silicon only.",
            sidecar_binary_name()
        )
    })?;

    println!("[Bridge] Starting lu-bridge media sidecar on port {BRIDGE_PORT}");
    let mut cmd = Command::new(&binary);
    cmd.env("LU_BRIDGE_NO_WINDOW", "1") // headless — the desktop app owns the window
        .env("LU_REQUIRE_AUTH", "0") // fully local, no cloud JWKS
        .env("LU_BRIDGE_ADDR", format!("127.0.0.1:{BRIDGE_PORT}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn lu-bridge: {e}"))?;

    *state.media_bridge.lock().unwrap() = Some(child);

    if let Err(e) = wait_for_bridge_health(BRIDGE_PORT) {
        stop_bridge_locked(&state);
        return Err(e);
    }

    println!("[Bridge] lu-bridge healthy on port {BRIDGE_PORT}");
    Ok(serde_json::json!({ "status": "started", "port": BRIDGE_PORT }))
}

/// Stop the managed bridge, killing the child. Idempotent.
#[tauri::command]
pub fn stop_media_bridge(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let killed = stop_bridge_locked(&state);
    Ok(serde_json::json!({ "status": if killed { "stopped" } else { "not_running" } }))
}

/// `running` reflects our child handle; `healthy` the HTTP probe (true even for
/// a user-run bridge we didn't spawn).
#[tauri::command]
pub fn media_bridge_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let running = state.media_bridge.lock().unwrap().is_some();
    Ok(serde_json::json!({
        "running": running,
        "healthy": bridge_healthy(BRIDGE_PORT),
        "port": BRIDGE_PORT,
    }))
}

fn stop_bridge_locked(state: &State<'_, AppState>) -> bool {
    let mut guard = state.media_bridge.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        return true;
    }
    false
}
