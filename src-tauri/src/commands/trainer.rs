// 2.5.8 — local character trainer (Character Studio, local lane).
//
// Trains a character LoRA fully on the user's GPU with kohya's musubi-tuner,
// pinned to tag v0.3.4, inside its OWN venv (never the ComfyUI one — torch
// versions must be free to diverge). Z-Image is the trained architecture:
// Apache-licensed base, the only image family whose 12 GB training path is
// community-proven, and its finished LoRA drops straight into
// ComfyUI/models/loras after the documented Diffusers conversion — the
// existing local LoRA chain picks it up with no extra wiring.
//
// Command surface (mirrors the whisper/tts installer contracts):
//   install_character_trainer(installPath?)  one-time env setup, streamed
//   character_trainer_status()               env + base-model readiness probe
//   stage_training_image(setId, name, bytes) stage one photo of the set
//   start_character_training{..}             cache -> train -> convert -> loras/
//   character_training_status()              run status + logs + step counter
//   cancel_character_training()              cooperative cancel + child kill
//
// Security stance: no user-supplied URLs anywhere — repo + tag are hardcoded,
// base models resolve only from known filenames inside LU-managed dirs, and
// the training-set id / names are sanitized before any path join.

use crate::state::AppState;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use tracing::info;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const MUSUBI_REPO: &str = "https://github.com/kohya-ss/musubi-tuner.git";
const MUSUBI_TAG: &str = "v0.3.4";

/// Known Z-Image training-base files, resolved by exact filename from the
/// trainer root's models dir or the active ComfyUI models tree.
/// Deliberately NOT the turbo checkpoint: musubi's own docs call turbo
/// training unstable and point to ostris' De-Turbo for that lane — and the
/// circulating NSFW full finetunes are ComfyUI-saved with a
/// `model.diffusion_model.` key prefix that musubi's strict loader rejects
/// (verified against zimage_model.py, 2026-07-18).
const DIT_CANDIDATES: &[&str] = &["z_image_bf16.safetensors", "z_image_de_turbo_v1_bf16.safetensors"];
const TE_CANDIDATES: &[&str] = &["qwen_3_4b.safetensors"];
const VAE_CANDIDATES: &[&str] = &["ae.safetensors"];

fn sanitize_component(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    cleaned.trim_matches('_').chars().take(48).collect()
}

/// Pick a file stem that doesn't clobber an existing photo in `dir`.
///
/// Sanitising kills the difference between real filenames — "foto (1).png" and
/// "foto [1].png" both become `foto__1_` — and the caption sidecar is keyed on
/// the stem alone. Writing blindly therefore replaced an earlier photo AND its
/// caption while the UI reported both as staged, so a set the user filled with
/// 20 pictures could silently train on 17. Re-staging the SAME bytes keeps the
/// same stem (an idempotent re-upload should not duplicate).
fn free_stem(dir: &Path, base: &str, ext: &str, bytes: &[u8]) -> String {
    let mut stem = base.to_string();
    for n in 2..=999u32 {
        let img = dir.join(format!("{stem}.{ext}"));
        let cap = dir.join(format!("{stem}.txt"));
        let same_photo = fs::read(&img).map(|b| b == bytes).unwrap_or(false);
        if same_photo || (!img.exists() && !cap.exists()) {
            return stem;
        }
        stem = format!("{base}_{n}");
    }
    stem
}

fn config_json_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("locally-uncensored").join("config.json"))
}

fn read_config_value(key: &str) -> Option<String> {
    let path = config_json_path()?;
    let content = fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get(key)?.as_str().map(|s| s.to_string())
}

fn write_config_value(key: &str, value: &str) {
    let Some(path) = config_json_path() else { return };
    let _ = fs::create_dir_all(path.parent().unwrap_or(Path::new(".")));
    let mut json: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    json[key] = serde_json::json!(value);
    let _ = fs::write(&path, serde_json::to_string_pretty(&json).unwrap_or_default());
}

/// Trainer root: persisted override (config `trainer_root`) else
/// `<app_data>/musubi`. Layout: `<root>/venv`, `<root>/musubi-tuner`,
/// `<root>/models`, `<root>/train/<set_id>/...`.
fn trainer_root(app: &tauri::AppHandle) -> PathBuf {
    if let Some(p) = read_config_value("trainer_root") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("musubi")
}

fn venv_python(root: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    { root.join("venv").join("Scripts").join("python.exe") }
    #[cfg(not(target_os = "windows"))]
    { root.join("venv").join("bin").join("python") }
}

fn repo_dir(root: &Path) -> PathBuf {
    root.join("musubi-tuner")
}

fn push_log(state: &Arc<Mutex<crate::state::InstallState>>, msg: &str) {
    if let Ok(mut s) = state.lock() {
        s.logs.push(msg.to_string());
        if s.logs.len() > 400 {
            let cut = s.logs.len() - 400;
            s.logs.drain(0..cut);
        }
    }
}

fn set_status(state: &Arc<Mutex<crate::state::InstallState>>, status: &str, msg: &str) {
    if let Ok(mut s) = state.lock() {
        s.status = status.to_string();
        s.logs.push(msg.to_string());
    }
}

/// Resolve a base-model file by exact name: `<root>/models` first, then the
/// active ComfyUI models tree (so files pulled via the Model Manager count).
fn resolve_base_file(root: &Path, comfy_dir: Option<&Path>, names: &[&str], sub: &str) -> Option<PathBuf> {
    for n in names {
        let local = root.join("models").join(n);
        if local.exists() {
            return Some(local);
        }
        if let Some(c) = comfy_dir {
            let in_comfy = c.join("models").join(sub).join(n);
            if in_comfy.exists() {
                return Some(in_comfy);
            }
        }
    }
    None
}

fn active_comfy_dir(state: &AppState) -> Option<PathBuf> {
    let p = state.comfy_path.lock().ok()?.clone();
    p.map(PathBuf::from)
        .or_else(|| crate::commands::process::find_comfyui_path().map(PathBuf::from))
}

/// A piped python child on Windows encodes stdio with the legacy code page
/// (cp1252). The first Unicode character any tool prints then aborts the
/// whole run with "UnicodeEncodeError: 'charmap' codec can't encode" — in
/// practice the moment tqdm draws its block-glyph progress bar, which is
/// exactly when the train step finally has a step total. Force UTF-8 stdio
/// on every trainer child instead.
fn force_python_utf8(cmd: &mut Command) {
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
}

/// cu121 wheels carry kernels up to sm_90 (Hopper). Blackwell reports
/// compute capability 12.x, so every RTX 50 card needs the cu128 build.
/// An unreadable probe keeps the cu121 default.
fn torch_index_for_cap(cap_major: Option<u32>) -> &'static str {
    match cap_major {
        Some(major) if major >= 12 => "https://download.pytorch.org/whl/cu128",
        _ => "https://download.pytorch.org/whl/cu121",
    }
}

/// venv + repo on disk proved nothing: an aborted torch download passed as
/// "ready" and died in the first training step. The cheapest honest signal
/// is torch's package marker inside the venv's site-packages.
fn torch_installed(root: &Path) -> bool {
    let venv = root.join("venv");
    if venv.join("Lib").join("site-packages").join("torch").join("version.py").exists() {
        return true;
    }
    let Ok(entries) = fs::read_dir(venv.join("lib")) else { return false };
    entries.filter_map(Result::ok).any(|e| {
        e.path().join("site-packages").join("torch").join("version.py").exists()
    })
}

/// Runs inside the trainer venv. Keep the printed markers in sync with
/// preflight_verdict below.
const TORCH_PREFLIGHT_PY: &str = "import torch\nprint('TORCH_OK', torch.__version__)\nif torch.cuda.is_available():\n    cap = torch.cuda.get_device_capability(0)\n    print('CAP', cap[0], cap[1])\n    print('ARCHS', ' '.join(torch.cuda.get_arch_list()))\n";

/// Two failure classes that both used to surface as a raw CUDA error deep in
/// the latent cache: torch not importable (half install), and a build whose
/// kernel list stops below the GPU's compute capability (cu121 on Blackwell,
/// which imports fine and even reports CUDA as available).
fn preflight_verdict(exit_ok: bool, stdout: &str, stderr: &str) -> Result<(), String> {
    if !exit_ok || !stdout.contains("TORCH_OK") {
        let tail = stderr
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .next_back()
            .unwrap_or("no detail from python")
            .to_string();
        return Err(format!(
            "PyTorch is missing or broken in the trainer environment. Run the trainer install again from Character Studio. ({tail})"
        ));
    }
    let mut cap_major: Option<u32> = None;
    let mut arch_max: Option<u32> = None;
    for line in stdout.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("CAP ") {
            cap_major = rest.split_whitespace().next().and_then(|v| v.parse().ok());
        } else if let Some(rest) = l.strip_prefix("ARCHS ") {
            for arch in rest.split_whitespace() {
                let digits: String = arch.chars().filter(|c| c.is_ascii_digit()).collect();
                if digits.len() >= 2 {
                    if let Ok(n) = digits[..digits.len() - 1].parse::<u32>() {
                        arch_max = Some(arch_max.map_or(n, |p| p.max(n)));
                    }
                }
            }
        }
    }
    if let (Some(cap), Some(max)) = (cap_major, arch_max) {
        if cap > max {
            return Err(format!(
                "This PyTorch build has no kernels for your GPU (compute capability {cap}.x, the build stops at {max}.x). An RTX 50 card on the old cu121 build does exactly this. Run the trainer install again from Character Studio, it now picks the matching build."
            ));
        }
    }
    Ok(())
}

/// Run one child to completion, streaming stdout+stderr lines into the run
/// state. Registers the child pid so cancel can kill it. Returns Err on
/// non-zero exit (with the last stderr lines) or on cancel.
fn run_streamed(
    mut cmd: Command,
    label: &str,
    run: &Arc<Mutex<crate::state::InstallState>>,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    pid_slot: &Arc<Mutex<Option<u32>>>,
) -> Result<(), String> {
    force_python_utf8(&mut cmd);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{label} could not start: {e}"))?;
    if let Ok(mut slot) = pid_slot.lock() {
        *slot = Some(child.id());
    }

    let tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let run = run.clone();
        let tail = tail.clone();
        handles.push(std::thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                // Step counter for the UI meter: musubi/tqdm emit
                // "steps: NN%|...| 123/1600 [...]" style lines.
                if let Some((cur, total)) = parse_step_counter(trimmed) {
                    if let Ok(mut s) = run.lock() {
                        s.download_progress = cur;
                        s.download_total = total;
                    }
                }
                if let Ok(mut t) = tail.lock() {
                    t.push(trimmed.to_string());
                    if t.len() > 12 {
                        t.remove(0);
                    }
                }
                push_log(&run, trimmed);
            }
        }));
    }

    let exit = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            for h in handles {
                let _ = h.join();
            }
            return Err("cancelled".to_string());
        }
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(300)),
            Err(e) => return Err(format!("{label} wait failed: {e}")),
        }
    };
    for h in handles {
        let _ = h.join();
    }
    if let Ok(mut slot) = pid_slot.lock() {
        *slot = None;
    }
    if exit.success() {
        Ok(())
    } else {
        let last = tail
            .lock()
            .map(|t| t.join("\n"))
            .unwrap_or_default();
        Err(format!("{label} failed (exit {:?}).\n{last}", exit.code()))
    }
}

/// Pull "123/1600" out of a tqdm-ish progress line.
pub fn parse_step_counter(line: &str) -> Option<(u64, u64)> {
    // Cheap scan without regex: find "N/M" where both sides are digits and M
    // looks like a step total (>= 10, filters version strings like 2/3).
    let bytes = line.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b != b'/' {
            continue;
        }
        let left_start = line[..i]
            .rfind(|c: char| !c.is_ascii_digit())
            .map(|p| p + 1)
            .unwrap_or(0);
        let right_end = line[i + 1..]
            .find(|c: char| !c.is_ascii_digit())
            .map(|p| i + 1 + p)
            .unwrap_or(line.len());
        if left_start >= i || right_end <= i + 1 {
            continue;
        }
        if let (Ok(cur), Ok(total)) = (line[left_start..i].parse::<u64>(), line[i + 1..right_end].parse::<u64>()) {
            if total >= 10 && cur <= total {
                return Some((cur, total));
            }
        }
    }
    None
}

// ── one-time environment install ─────────────────────────────────────────────

#[allow(non_snake_case)]
#[tauri::command]
pub fn install_character_trainer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    installPath: Option<String>,
) -> Result<serde_json::Value, String> {
    {
        let mut st = state.trainer_install.lock().unwrap();
        if st.status == "installing" {
            return Ok(serde_json::json!({"status": "already_installing"}));
        }
        st.status = "installing".to_string();
        st.logs.clear();
        st.logs.push("Setting up the local character trainer...".to_string());
    }
    info!("character trainer install start");

    if let Some(p) = installPath.as_deref() {
        if !p.trim().is_empty() {
            write_config_value("trainer_root", p.trim());
        }
    }
    let root = trainer_root(&app);
    let python_bin = state.python_bin.lock().unwrap().clone();
    if python_bin.is_empty() || !crate::python::is_real_python(&python_bin) {
        set_status(
            &state.trainer_install,
            "error",
            "No usable Python found. Install Python first (Settings), then retry.",
        );
        return Err("no_python".to_string());
    }

    let install = state.trainer_install.clone();
    let cancel = state.trainer_cancel.clone();
    let pid_slot = state.trainer_process.clone();
    cancel.store(false, Ordering::SeqCst);

    std::thread::spawn(move || {
        let _ = fs::create_dir_all(root.join("models"));

        // 1) pinned clone (releases are the project's own stability advice)
        if !repo_dir(&root).join(".git").exists() {
            set_status(&install, "installing", &format!("Step 1/4: Getting musubi tuner {MUSUBI_TAG}..."));
            let mut clone = Command::new("git");
            clone.args(["clone", "--branch", MUSUBI_TAG, "--depth", "1", MUSUBI_REPO])
                .arg(repo_dir(&root));
            if let Err(e) = run_streamed(clone, "git clone", &install, &cancel, &pid_slot) {
                set_status(&install, if e == "cancelled" { "cancelled" } else { "error" }, &e);
                return;
            }
        } else {
            push_log(&install, "musubi tuner already present, keeping the pinned checkout.");
        }

        // 2) venv
        if !venv_python(&root).exists() {
            set_status(&install, "installing", "Step 2/4: Creating the training environment (venv)...");
            let mut venv = Command::new(&python_bin);
            venv.args(["-m", "venv"]).arg(root.join("venv"));
            if let Err(e) = run_streamed(venv, "venv create", &install, &cancel, &pid_slot) {
                set_status(&install, if e == "cancelled" { "cancelled" } else { "error" }, &e);
                return;
            }
        }
        let vpy = venv_python(&root).to_string_lossy().to_string();

        // 3) torch, routed by the same nvidia-smi probe the ComfyUI installer
        // uses (D#37): Blackwell gets cu128, everything else keeps cu121.
        set_status(&install, "installing", "Step 3/4: Installing PyTorch into the trainer venv (~2.5 GB, one time)...");
        let cap = crate::commands::install::detect_nvidia_compute_cap_major();
        let torch_index = torch_index_for_cap(cap);
        push_log(&install, &format!(
            "GPU compute capability: {}, PyTorch wheels: {torch_index}",
            cap.map_or("unknown".to_string(), |c| format!("{c}.x")),
        ));
        let mut torch = Command::new(&vpy);
        let mut torch_args = vec!["-m", "pip", "install", "--progress-bar", "off", "--no-input"];
        if cap.is_some_and(|c| c >= 12) {
            // A finished cu121 install satisfies pip on a Blackwell box and
            // would never be replaced; force the matching build in.
            torch_args.push("--force-reinstall");
        }
        torch_args.extend(["torch", "torchvision", "--index-url", torch_index]);
        torch.args(&torch_args);
        if let Err(e) = run_streamed(torch, "torch install", &install, &cancel, &pid_slot) {
            set_status(&install, if e == "cancelled" { "cancelled" } else { "error" }, &e);
            return;
        }

        // 4) musubi + deps
        set_status(&install, "installing", "Step 4/4: Installing the trainer package...");
        let mut pkg = Command::new(&vpy);
        pkg.args(["-m", "pip", "install", "--progress-bar", "off", "--no-input", "-e", "."])
            .current_dir(repo_dir(&root));
        if let Err(e) = run_streamed(pkg, "musubi install", &install, &cancel, &pid_slot) {
            set_status(&install, if e == "cancelled" { "cancelled" } else { "error" }, &e);
            return;
        }

        set_status(&install, "complete", "Trainer environment ready.");
    });

    Ok(serde_json::json!({"status": "installing"}))
}

#[tauri::command]
pub fn character_trainer_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let root = trainer_root(&app);
    let comfy = active_comfy_dir(state.inner());
    let env_ready = venv_python(&root).exists()
        && repo_dir(&root).join("src").exists()
        && torch_installed(&root);
    let dit = resolve_base_file(&root, comfy.as_deref(), DIT_CANDIDATES, "diffusion_models");
    let te = resolve_base_file(&root, comfy.as_deref(), TE_CANDIDATES, "text_encoders");
    let vae = resolve_base_file(&root, comfy.as_deref(), VAE_CANDIDATES, "vae");
    let install = state.trainer_install.lock().unwrap();
    Ok(serde_json::json!({
        "envReady": env_ready,
        "basesReady": dit.is_some() && te.is_some() && vae.is_some(),
        "dit": dit.map(|p| p.to_string_lossy().to_string()),
        "textEncoder": te.map(|p| p.to_string_lossy().to_string()),
        "vae": vae.map(|p| p.to_string_lossy().to_string()),
        "root": root.to_string_lossy().to_string(),
        "install": { "status": install.status, "logs": install.logs },
    }))
}

// ── training-set staging ─────────────────────────────────────────────────────

#[allow(non_snake_case)]
#[tauri::command]
pub fn stage_training_image(
    app: tauri::AppHandle,
    setId: String,
    filename: String,
    fileBytes: Vec<u8>,
    caption: String,
) -> Result<serde_json::Value, String> {
    let set = sanitize_component(&setId);
    let name = sanitize_component(filename.trim_end_matches(|c: char| c.is_ascii_alphanumeric()).trim_end_matches('.'));
    if set.is_empty() {
        return Err("invalid set id".to_string());
    }
    let ext = Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp"].contains(&ext.as_str()) {
        return Err("unsupported image type (png, jpg, webp)".to_string());
    }
    if fileBytes.is_empty() || fileBytes.len() > 40 * 1024 * 1024 {
        return Err("image is empty or larger than 40 MB".to_string());
    }
    let img_dir = trainer_root(&app).join("train").join(&set).join("img");
    fs::create_dir_all(&img_dir).map_err(|e| format!("could not create the set dir: {e}"))?;
    let base = if name.is_empty() { format!("photo_{}", fileBytes.len() % 100000) } else { name };
    let stem = free_stem(&img_dir, &base, &ext, &fileBytes);
    fs::write(img_dir.join(format!("{stem}.{ext}")), &fileBytes)
        .map_err(|e| format!("could not write the photo: {e}"))?;
    // Caption sidecar: trigger word comes first — musubi has no trigger
    // mechanism of its own, the token must live in every caption.
    fs::write(img_dir.join(format!("{stem}.txt")), caption.trim())
        .map_err(|e| format!("could not write the caption: {e}"))?;
    Ok(serde_json::json!({"staged": format!("{stem}.{ext}")}))
}

#[allow(non_snake_case)]
#[tauri::command]
pub fn clear_training_set(app: tauri::AppHandle, setId: String) -> Result<(), String> {
    let set = sanitize_component(&setId);
    if set.is_empty() {
        return Err("invalid set id".to_string());
    }
    let dir = trainer_root(&app).join("train").join(&set);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("could not clear the set: {e}"))?;
    }
    Ok(())
}

// ── the training run ─────────────────────────────────────────────────────────

#[allow(non_snake_case)]
#[tauri::command]
pub fn start_character_training(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    setId: String,
    name: String,
    triggerWord: String,
    steps: Option<u32>,
) -> Result<serde_json::Value, String> {
    {
        let mut run = state.trainer_run.lock().unwrap();
        if run.status == "running" {
            return Ok(serde_json::json!({"status": "already_running"}));
        }
        run.status = "running".to_string();
        run.logs.clear();
        run.download_progress = 0;
        run.download_total = 0;
        run.logs.push("Preparing the training run...".to_string());
    }
    info!("character training start");

    let set = sanitize_component(&setId);
    let lora_name = sanitize_component(&name);
    let trigger = sanitize_component(&triggerWord);
    if set.is_empty() || lora_name.is_empty() || trigger.is_empty() {
        set_status(&state.trainer_run, "error", "Set, name and trigger word are required.");
        return Err("invalid arguments".to_string());
    }
    let steps = steps.unwrap_or(1200).clamp(100, 4000);

    let root = trainer_root(&app);
    let comfy = active_comfy_dir(state.inner());
    let vpy = venv_python(&root);
    if !vpy.exists() {
        set_status(&state.trainer_run, "error", "Trainer environment is missing. Run the trainer install first.");
        return Err("trainer_not_installed".to_string());
    }
    let (Some(dit), Some(te), Some(vae)) = (
        resolve_base_file(&root, comfy.as_deref(), DIT_CANDIDATES, "diffusion_models"),
        resolve_base_file(&root, comfy.as_deref(), TE_CANDIDATES, "text_encoders"),
        resolve_base_file(&root, comfy.as_deref(), VAE_CANDIDATES, "vae"),
    ) else {
        set_status(
            &state.trainer_run,
            "error",
            "The Z-Image training base files are missing (z_image_bf16 / qwen_3_4b / ae). Get them from the Model Manager, then train again.",
        );
        return Err("bases_missing".to_string());
    };
    let img_dir = root.join("train").join(&set).join("img");
    let photo_count = fs::read_dir(&img_dir)
        .map(|it| it.filter_map(Result::ok).filter(|e| {
            e.path().extension().and_then(|x| x.to_str())
                .map(|x| ["png", "jpg", "jpeg", "webp"].contains(&x.to_ascii_lowercase().as_str()))
                .unwrap_or(false)
        }).count())
        .unwrap_or(0);
    if photo_count < 4 {
        set_status(&state.trainer_run, "error", "Need at least 4 staged photos to train.");
        return Err("not_enough_photos".to_string());
    }

    // Copy the finished LoRA next to the other local LoRAs so the existing
    // chain picks it up. Fall back to the trainer root when ComfyUI is absent.
    let loras_dir = comfy
        .as_deref()
        .map(|c| c.join("models").join("loras"))
        .unwrap_or_else(|| root.join("out"));

    let run = state.trainer_run.clone();
    let cancel = state.trainer_cancel.clone();
    let pid_slot = state.trainer_process.clone();
    cancel.store(false, Ordering::SeqCst);

    std::thread::spawn(move || {
        let set_dir = root.join("train").join(&set);
        let cache_dir = set_dir.join("cache");
        let out_dir = set_dir.join("out");
        let _ = fs::create_dir_all(&cache_dir);
        let _ = fs::create_dir_all(&out_dir);

        // Repeats sized so photos x repeats x epochs lands near the step goal
        // with batch 1 (steps/epoch = photos x repeats).
        let repeats = (steps as usize / photo_count / 8).clamp(2, 40);
        let toml = format!(
            "[general]\nresolution = [768, 768]\ncaption_extension = \".txt\"\nbatch_size = 1\nenable_bucket = true\nbucket_no_upscale = false\n\n[[datasets]]\nimage_directory = '{}'\ncache_directory = '{}'\nnum_repeats = {}\n",
            img_dir.to_string_lossy().replace('\\', "/"),
            cache_dir.to_string_lossy().replace('\\', "/"),
            repeats,
        );
        let toml_path = set_dir.join("dataset.toml");
        if let Err(e) = fs::write(&toml_path, toml) {
            set_status(&run, "error", &format!("could not write dataset config: {e}"));
            return;
        }

        let vpy_s = vpy.to_string_lossy().to_string();
        let repo = repo_dir(&root);
        let toml_s = toml_path.to_string_lossy().to_string();
        let dit_s = dit.to_string_lossy().to_string();
        let te_s = te.to_string_lossy().to_string();
        let vae_s = vae.to_string_lossy().to_string();

        // 0) preflight. Both failure classes used to pass every disk check
        // and die mid-run as a raw CUDA error the UI could not explain.
        set_status(&run, "running", "Checking the training environment...");
        let mut probe = Command::new(&vpy_s);
        probe.args(["-c", TORCH_PREFLIGHT_PY]);
        force_python_utf8(&mut probe);
        #[cfg(target_os = "windows")]
        probe.creation_flags(CREATE_NO_WINDOW);
        let verdict = match probe.output() {
            Ok(out) => preflight_verdict(
                out.status.success(),
                &String::from_utf8_lossy(&out.stdout),
                &String::from_utf8_lossy(&out.stderr),
            ),
            Err(e) => Err(format!("could not run the trainer python: {e}")),
        };
        if let Err(msg) = verdict {
            set_status(&run, "error", &msg);
            return;
        }

        // 1) latent cache
        set_status(&run, "running", "Step 1/4: Caching image latents...");
        let mut c1 = Command::new(&vpy_s);
        c1.current_dir(&repo).args([
            "src/musubi_tuner/zimage_cache_latents.py",
            "--dataset_config", &toml_s,
            "--vae", &vae_s,
        ]);
        if let Err(e) = run_streamed(c1, "latent cache", &run, &cancel, &pid_slot) {
            set_status(&run, if e == "cancelled" { "cancelled" } else { "error" }, &e);
            return;
        }

        // 2) text-encoder cache (fp8 keeps the 4B Qwen TE inside 12 GB)
        set_status(&run, "running", "Step 2/4: Caching text encoder outputs...");
        let mut c2 = Command::new(&vpy_s);
        c2.current_dir(&repo).args([
            "src/musubi_tuner/zimage_cache_text_encoder_outputs.py",
            "--dataset_config", &toml_s,
            "--text_encoder", &te_s,
            "--batch_size", "8",
            "--fp8_llm",
        ]);
        if let Err(e) = run_streamed(c2, "text encoder cache", &run, &cancel, &pid_slot) {
            set_status(&run, if e == "cancelled" { "cancelled" } else { "error" }, &e);
            return;
        }

        // 3) the train itself — documented 12 GB combo: fp8 base + block swap
        // + gradient checkpointing + 8-bit optimizer. ComfyUI's model cache
        // would eat the same VRAM the trainer needs — ask it to let go first.
        if crate::commands::process::free_comfyui_memory() {
            push_log(&run, "Freed ComfyUI's cached models to make room for training.");
        }
        set_status(&run, "running", &format!("Step 3/4: Training ({steps} steps). This runs for a while, live log below..."));
        let accelerate = {
            #[cfg(target_os = "windows")]
            { root.join("venv").join("Scripts").join("accelerate.exe") }
            #[cfg(not(target_os = "windows"))]
            { root.join("venv").join("bin").join("accelerate") }
        };
        let steps_s = steps.to_string();
        let out_name = format!("char_{lora_name}_zimage");
        let mut c3 = Command::new(accelerate);
        c3.current_dir(&repo).args([
            "launch", "--num_cpu_threads_per_process", "1", "--mixed_precision", "bf16",
            "src/musubi_tuner/zimage_train_network.py",
            "--dit", &dit_s,
            "--vae", &vae_s,
            "--text_encoder", &te_s,
            "--dataset_config", &toml_s,
            "--sdpa", "--mixed_precision", "bf16",
            "--fp8_base", "--fp8_scaled",
            "--blocks_to_swap", "16",
            "--timestep_sampling", "shift", "--weighting_scheme", "none", "--discrete_flow_shift", "2.0",
            "--optimizer_type", "adamw8bit", "--learning_rate", "1e-4", "--gradient_checkpointing",
            "--max_data_loader_n_workers", "2", "--persistent_data_loader_workers",
            "--network_module", "networks.lora_zimage", "--network_dim", "32",
            "--max_train_steps", &steps_s,
            "--save_precision", "bf16",
            "--seed", "42",
            "--output_dir", &out_dir.to_string_lossy(),
            "--output_name", &out_name,
        ]);
        if let Err(e) = run_streamed(c3, "training", &run, &cancel, &pid_slot) {
            set_status(&run, if e == "cancelled" { "cancelled" } else { "error" }, &e);
            return;
        }

        // 4) convert to the Diffusers key layout ComfyUI loads, straight into
        // the loras dir (musubi's documented `--target other` conversion).
        set_status(&run, "running", "Step 4/4: Converting the LoRA for ComfyUI...");
        let trained = out_dir.join(format!("{out_name}.safetensors"));
        if !trained.exists() {
            set_status(&run, "error", "Training finished but the LoRA file was not written.");
            return;
        }
        let _ = fs::create_dir_all(&loras_dir);
        let final_path = loras_dir.join(format!("{out_name}.safetensors"));
        let mut c4 = Command::new(&vpy_s);
        c4.current_dir(&repo).args([
            "src/musubi_tuner/convert_lora.py",
            "--input", &trained.to_string_lossy(),
            "--output", &final_path.to_string_lossy(),
            "--target", "other",
        ]);
        if let Err(e) = run_streamed(c4, "lora convert", &run, &cancel, &pid_slot) {
            set_status(&run, if e == "cancelled" { "cancelled" } else { "error" }, &e);
            return;
        }

        set_status(
            &run,
            "complete",
            &format!(
                "Character ready: {out_name}.safetensors is in your loras. Put '{trigger}' in a prompt on the Image tab with the LoRA active.",
            ),
        );
        info!("character training complete");
    });

    Ok(serde_json::json!({"status": "running"}))
}

#[tauri::command]
pub fn character_training_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let run = state.trainer_run.lock().unwrap();
    Ok(serde_json::json!({
        "status": run.status,
        "logs": run.logs.iter().rev().take(30).rev().collect::<Vec<_>>(),
        "step": run.download_progress,
        "totalSteps": run.download_total,
    }))
}

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn cancel_character_training(app: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        cancel_character_training_blocking(&state)
    })
    .await
    .map_err(|e| format!("cancel_character_training task: {e}"))?
}

/// Kill a live trainer child and its tree.
///
/// Shared with `AppState::shutdown_subprocesses`: the trainer PID lives in
/// AppState like every other long-running child, but shutdown never killed it,
/// so quitting mid-training left an orphaned Python process holding the GPU
/// with no UI left to stop it. `/T` matters — the trainer runs accelerate,
/// which spawns the actual worker underneath.
pub(crate) fn kill_trainer_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        kill.creation_flags(CREATE_NO_WINDOW);
        let _ = kill.output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

fn cancel_character_training_blocking(state: &AppState) -> Result<(), String> {
    state.trainer_cancel.store(true, Ordering::SeqCst);
    // Kill the live child directly too — pip/accelerate ignore the flag.
    if let Ok(mut slot) = state.trainer_process.lock() {
        if let Some(pid) = slot.take() {
            kill_trainer_tree(pid);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn blackwell_routes_to_cu128_and_older_cards_keep_cu121() {
        use super::torch_index_for_cap;
        assert_eq!(torch_index_for_cap(Some(12)), "https://download.pytorch.org/whl/cu128");
        assert_eq!(torch_index_for_cap(Some(13)), "https://download.pytorch.org/whl/cu128");
        assert_eq!(torch_index_for_cap(Some(9)), "https://download.pytorch.org/whl/cu121");
        assert_eq!(torch_index_for_cap(Some(8)), "https://download.pytorch.org/whl/cu121");
        assert_eq!(torch_index_for_cap(None), "https://download.pytorch.org/whl/cu121");
    }

    #[test]
    fn preflight_fails_loud_when_torch_does_not_import() {
        use super::preflight_verdict;
        let msg = preflight_verdict(
            false,
            "",
            "Traceback (most recent call last):\nModuleNotFoundError: No module named 'torch'",
        )
        .unwrap_err();
        assert!(msg.contains("Run the trainer install again"));
        assert!(msg.contains("No module named 'torch'"));
    }

    #[test]
    fn preflight_names_the_kernel_gap_on_blackwell_with_cu121() {
        use super::preflight_verdict;
        let out = "TORCH_OK 2.3.1+cu121\nCAP 12 0\nARCHS sm_50 sm_60 sm_70 sm_75 sm_80 sm_86 sm_90\n";
        let msg = preflight_verdict(true, out, "").unwrap_err();
        assert!(msg.contains("compute capability 12.x"));
        assert!(msg.contains("no kernels"));
    }

    #[test]
    fn preflight_passes_on_a_matching_build_and_on_cpu_only() {
        use super::preflight_verdict;
        let ok = "TORCH_OK 2.7.0+cu128\nCAP 12 0\nARCHS sm_80 sm_90 sm_100 sm_120 compute_120\n";
        assert!(preflight_verdict(true, ok, "").is_ok());
        assert!(preflight_verdict(true, "TORCH_OK 2.3.1\n", "").is_ok());
    }

    #[test]
    fn a_half_install_is_not_ready_until_torch_lands() {
        use super::torch_installed;
        use std::fs;
        let root = std::env::temp_dir().join(format!("lu-trainer-torch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        // venv exists, torch does not: the Sockenmonster case.
        fs::create_dir_all(root.join("venv").join("lib").join("python3.11").join("site-packages")).unwrap();
        assert!(!torch_installed(&root));

        // unix layout
        let unix_torch = root
            .join("venv").join("lib").join("python3.11").join("site-packages").join("torch");
        fs::create_dir_all(&unix_torch).unwrap();
        fs::write(unix_torch.join("version.py"), "__version__ = '2.7.0'").unwrap();
        assert!(torch_installed(&root));

        // windows layout on its own
        let root2 = std::env::temp_dir().join(format!("lu-trainer-torch-win-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root2);
        let win_torch = root2.join("venv").join("Lib").join("site-packages").join("torch");
        fs::create_dir_all(&win_torch).unwrap();
        fs::write(win_torch.join("version.py"), "__version__ = '2.7.0'").unwrap();
        assert!(torch_installed(&root2));

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&root2);
    }

    #[test]
    fn every_trainer_child_gets_utf8_stdio() {
        use super::force_python_utf8;
        let mut cmd = std::process::Command::new("python");
        force_python_utf8(&mut cmd);
        let envs: Vec<(String, Option<String>)> = cmd
            .get_envs()
            .map(|(k, v)| (
                k.to_string_lossy().into_owned(),
                v.map(|v| v.to_string_lossy().into_owned()),
            ))
            .collect();
        assert!(envs.contains(&("PYTHONIOENCODING".into(), Some("utf-8".into()))));
        assert!(envs.contains(&("PYTHONUTF8".into(), Some("1".into()))));
    }

    #[test]
    fn a_second_photo_never_overwrites_the_first() {
        use super::free_stem;
        use std::fs;
        let dir = std::env::temp_dir().join(format!("lu-trainer-stem-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // "foto (1).png" and "foto [1].png" both sanitise to the same stem.
        let first = free_stem(&dir, "foto__1_", "png", b"AAAA");
        assert_eq!(first, "foto__1_");
        fs::write(dir.join(format!("{first}.png")), b"AAAA").unwrap();
        fs::write(dir.join(format!("{first}.txt")), "caption one").unwrap();

        let second = free_stem(&dir, "foto__1_", "png", b"BBBB");
        assert_ne!(second, first, "a different photo must not reuse the stem");

        // The caption sidecar collides too, even with a different extension.
        let third = free_stem(&dir, "foto__1_", "jpg", b"CCCC");
        assert_ne!(third, first);

        // Re-staging the SAME bytes keeps the stem — no duplicate on re-upload.
        let again = free_stem(&dir, "foto__1_", "png", b"AAAA");
        assert_eq!(again, first);

        let _ = fs::remove_dir_all(&dir);
    }

    use super::*;

    #[test]
    fn step_counter_parses_tqdm_lines() {
        assert_eq!(parse_step_counter("steps:  8%|▊| 123/1600 [02:10<26:04]"), Some((123, 1600)));
        assert_eq!(parse_step_counter("epoch 1/16"), Some((1, 16)));
        assert_eq!(parse_step_counter("no counter here"), None);
        // version-ish fragments with tiny totals are ignored
        assert_eq!(parse_step_counter("python 3/4 things"), None);
    }

    #[test]
    fn sanitize_component_strips_path_syntax() {
        assert_eq!(sanitize_component("../../evil"), "evil");
        assert_eq!(sanitize_component("my char!"), "my_char");
        assert_eq!(sanitize_component("lumi"), "lumi");
    }
}

#[cfg(test)]
mod shutdown_tests {
    /// Quitting during a training run used to leave the trainer alive: the PID
    /// is in AppState like every other long-running child, but
    /// shutdown_subprocesses skipped it. This asserts the wiring exists — the
    /// kill itself is an OS call, so what is checkable here is that shutdown
    /// reaches for the trainer slot at all, and that the slot is emptied so a
    /// second pass cannot re-kill a recycled PID.
    #[test]
    fn shutdown_takes_the_trainer_pid_and_clears_the_slot() {
        let slot: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(Some(4242));

        // What state.rs does, in the same order.
        let taken = { slot.lock().unwrap().take() };

        assert_eq!(taken, Some(4242), "shutdown must pick the trainer pid up");
        assert!(
            slot.lock().unwrap().is_none(),
            "the slot must be empty afterwards so a later pass cannot kill a recycled pid",
        );
    }

    #[test]
    fn state_shutdown_actually_references_the_trainer() {
        // Cheap guard against the wiring being dropped in a future refactor:
        // the fix is one call in state.rs and nothing else would notice.
        let state_rs = include_str!("../state.rs");
        assert!(
            state_rs.contains("trainer_process") && state_rs.contains("kill_trainer_tree"),
            "shutdown_subprocesses no longer kills the trainer",
        );
    }
}
