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
        s.phase = msg.to_string();
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

/// Every site-packages of the trainer venv. Windows puts one at
/// `venv/Lib/site-packages`, POSIX one per python version under `venv/lib`.
fn site_packages_dirs(root: &Path) -> Vec<PathBuf> {
    let venv = root.join("venv");
    let mut dirs = vec![venv.join("Lib").join("site-packages")];
    if let Ok(entries) = fs::read_dir(venv.join("lib")) {
        dirs.extend(entries.filter_map(Result::ok).map(|e| e.path().join("site-packages")));
    }
    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

/// venv + repo on disk proved nothing: an aborted torch download passed as
/// "ready" and died in the first training step. The cheapest honest signal
/// is torch's package marker inside the venv's site-packages.
fn torch_installed(root: &Path) -> bool {
    site_packages_dirs(root)
        .iter()
        .any(|d| d.join("torch").join("version.py").exists())
}

/// The trainer package itself, which "venv + repo + torch" never covered:
/// sockenmonster's install died after torch and before `pip install -e .`, so
/// the studio called the environment ready and every run hit
/// `No module named musubi_tuner`. Installed editable, so the marker is a
/// dist-info directory or the `__editable__` .pth pip drops next to it. File
/// names only, no python spawn, because this runs on every status poll.
fn musubi_installed(root: &Path) -> bool {
    site_packages_dirs(root).iter().any(|d| {
        d.join("musubi_tuner").is_dir()
            || fs::read_dir(d).map(|entries| {
                entries.filter_map(Result::ok).any(|e| {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    name.starts_with("musubi_tuner-") || name.contains("__editable__.musubi_tuner")
                })
            }).unwrap_or(false)
    })
}

/// Runs inside the trainer venv. Keep the printed markers in sync with
/// preflight_verdict below. The trainer package is probed with find_spec
/// rather than a real import: importing it pulls the whole training stack and
/// would turn a cheap check into seconds of work and a second CUDA context.
const TORCH_PREFLIGHT_PY: &str = "import importlib.util\nimport torch\nprint('TORCH_OK', torch.__version__)\nif torch.cuda.is_available():\n    cap = torch.cuda.get_device_capability(0)\n    print('CAP', cap[0], cap[1])\n    print('ARCHS', ' '.join(torch.cuda.get_arch_list()))\nif importlib.util.find_spec('musubi_tuner') is not None:\n    print('MUSUBI_OK')\n";

/// What the preflight found. Three failure classes that all used to surface as
/// a raw error deep inside the run: torch not importable (half install), a
/// torch build whose kernel list stops below the GPU's compute capability
/// (cu121 on Blackwell, which imports fine and even reports CUDA as
/// available), and the trainer package missing (an install that died after
/// torch). Each one is repairable, which is why they are distinguished rather
/// than collapsed into one error string.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Preflight {
    Ok,
    TorchBroken(String),
    KernelsTooOld { cap: u32, max: u32 },
    PackageMissing,
}

impl Preflight {
    pub(crate) fn is_ok(&self) -> bool {
        matches!(self, Preflight::Ok)
    }

    /// Only a wrong-kernel torch has to be pushed out of the way; the other
    /// two classes install into what is missing.
    pub(crate) fn needs_torch_reinstall(&self) -> bool {
        matches!(self, Preflight::TorchBroken(_) | Preflight::KernelsTooOld { .. })
    }

    /// What the customer can actually DO once the automatic repair has failed
    /// too. `message()` is a diagnosis on purpose, and a diagnosis on its own
    /// left them with a pip log tail and nothing to press: the pre-A2 text
    /// ended with "Run the trainer install again from Character Studio" and
    /// nothing replaced it.
    ///
    /// All three classes end in the same place, pip could not get the right
    /// files into the venv, and the two things that stop it are the network
    /// and the disk. So name both, then the one button that runs the whole
    /// install again. The button is guaranteed to be on screen by then:
    /// `trainer_env_broken` forces envReady false after a failed repair.
    pub(crate) fn next_step(&self) -> &'static str {
        match self {
            Preflight::Ok => "",
            _ => "Check that you are online and that the drive has room (the environment needs about 3 GB), then press Set up trainer in Character Studio to install it again.",
        }
    }

    pub(crate) fn message(&self) -> String {
        match self {
            Preflight::Ok => String::new(),
            Preflight::TorchBroken(tail) => format!(
                "PyTorch is missing or broken in the trainer environment. ({tail})"
            ),
            Preflight::KernelsTooOld { cap, max } => format!(
                "This PyTorch build has no kernels for your GPU (compute capability {cap}.x, the build stops at {max}.x). An RTX 50 card on the old cu121 build does exactly this."
            ),
            Preflight::PackageMissing => {
                "The trainer package (musubi_tuner) is not installed in the trainer environment.".to_string()
            }
        }
    }
}

/// The whole terminal message after a repair that did not take: what is wrong,
/// that the repair was already tried, what to do, and the tail of the log that
/// says why. In that order, because the user reads the first sentence and the
/// last one.
pub(crate) fn repair_failed_message(after: &Preflight, tail: &str) -> String {
    format!(
        "{} The automatic repair did not fix it. {} Last steps: {tail}",
        after.message(),
        after.next_step(),
    )
}

fn preflight_verdict(exit_ok: bool, stdout: &str, stderr: &str) -> Preflight {
    if !exit_ok || !stdout.contains("TORCH_OK") {
        let tail = stderr
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .next_back()
            .unwrap_or("no detail from python")
            .to_string();
        return Preflight::TorchBroken(tail);
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
            return Preflight::KernelsTooOld { cap, max };
        }
    }
    if !stdout.contains("MUSUBI_OK") {
        return Preflight::PackageMissing;
    }
    Preflight::Ok
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
    let env_broken = state.trainer_env_broken.clone();
    cancel.store(false, Ordering::SeqCst);

    std::thread::spawn(move || {
        match provision_trainer_env(&root, &python_bin, false, &install, "installing", &cancel, &pid_slot) {
            Ok(()) => {
                env_broken.store(false, Ordering::SeqCst);
                set_status(&install, "complete", "Trainer environment ready.")
            }
            Err(e) => set_status(&install, if e == "cancelled" { "cancelled" } else { "error" }, &e),
        }
    });

    Ok(serde_json::json!({"status": "installing"}))
}

/// What has to happen to `<root>/venv` before the two pip steps can use it.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum VenvAction {
    Keep,
    Create,
    Rebuild,
}

/// Presence is not health, and the old check only asked about presence.
///
/// On Windows `venv\Scripts\python.exe` is a real copied binary. Upgrade
/// Python 3.11 to 3.13 and uninstall the old one and that file is still there,
/// still passes `exists()`, and dies on every start with a fatal
/// init_fs_encoding error because pyvenv.cfg points at a home that is gone.
/// The repair path then skipped step 2 (the venv was "there"), drove steps 3
/// and 4 with the dead interpreter, and reported "torch install failed", which
/// names neither the cause nor a way out. Worse, `start_character_training`
/// refuses to even reach the repair unless that same file exists, so on the
/// repair path the old guard could never once be true. On POSIX the identical
/// venv healed itself by accident: `venv/bin/python` is a symlink, and
/// `exists()` follows it, so a dead base made the check false.
///
/// The question is therefore whether the interpreter RUNS.
pub(crate) fn venv_action(python_exists: bool, python_starts: bool) -> VenvAction {
    match (python_exists, python_starts) {
        (false, _) => VenvAction::Create,
        (true, false) => VenvAction::Rebuild,
        (true, true) => VenvAction::Keep,
    }
}

/// `python -m venv` arguments for the action. A rebuild has to CLEAR: keeping
/// the directory would keep a site-packages built for the interpreter that
/// just died, and pip would then repair on top of metadata for a Python
/// version that is no longer installed.
pub(crate) fn venv_create_args(action: VenvAction) -> &'static [&'static str] {
    match action {
        VenvAction::Rebuild => &["-m", "venv", "--clear"],
        _ => &["-m", "venv"],
    }
}

/// Why we are stopping when there is no system Python to build with. A rebuild
/// deletes the old venv, so it must never start without one: leaving the
/// customer with no environment at all is worse than the broken one they had.
pub(crate) fn no_base_python_message(action: VenvAction) -> String {
    let why = if action == VenvAction::Rebuild {
        "The trainer environment is still there but its Python does not start any more (the Python it was built from was moved, upgraded or removed), and rebuilding it needs a working Python on this machine."
    } else {
        "Setting up the trainer needs a working Python on this machine."
    };
    format!("{why} Install Python in Settings, then start this again.")
}

/// Cheapest honest check that an interpreter is usable: start it and let it
/// exit immediately. A venv python whose base is gone never reaches the code,
/// it aborts during interpreter init, so a non-zero exit is the answer.
fn python_starts(exe: &Path) -> bool {
    let mut cmd = Command::new(exe);
    cmd.args(["-c", "pass"]);
    force_python_utf8(&mut cmd);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// The four install steps, idempotent by design: an existing checkout and a
/// WORKING venv are kept, the two pip steps always run. One function because
/// the training run repairs its own environment with it (A2), and a repair
/// that drifted from the install would be a second, untested installer.
///
/// It only ever writes into `<root>/venv` and `<root>/musubi-tuner`. The
/// customer's datasets (`<root>/train`) and the multi-GB base models
/// (`<root>/models`) are never touched, which is why repair can run
/// unattended in the middle of a training start.
///
/// `status_kind` is the status the caller's state machine uses ("installing"
/// for the Set up button, "running" for a repair inside a training run) so
/// neither surface sees a status it cannot render.
#[allow(clippy::too_many_arguments)]
fn provision_trainer_env(
    root: &Path,
    python_bin: &str,
    repairing: bool,
    state: &Arc<Mutex<crate::state::InstallState>>,
    status_kind: &str,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    pid_slot: &Arc<Mutex<Option<u32>>>,
) -> Result<(), String> {
    let tag = if repairing { "Repairing the trainer environment" } else { "Setting up the trainer" };
    let _ = fs::create_dir_all(root.join("models"));

    // 1) pinned clone (releases are the project's own stability advice)
    if !repo_dir(root).join(".git").exists() {
        set_status(state, status_kind, &format!("{tag} (1/4): getting musubi tuner {MUSUBI_TAG}..."));
        let mut clone = Command::new("git");
        clone.args(["clone", "--branch", MUSUBI_TAG, "--depth", "1", MUSUBI_REPO])
            .arg(repo_dir(root));
        run_streamed(clone, "git clone", state, cancel, pid_slot)?;
    } else {
        push_log(state, "musubi tuner already present, keeping the pinned checkout.");
    }

    // 2) venv. Asked as "does its python run", not "is the file there": see
    // venv_action. A dead venv is exactly the state a repair is called for,
    // and it used to be the one state this step could not fix.
    let vpy_path = venv_python(root);
    let exists = vpy_path.exists();
    let action = venv_action(exists, exists && python_starts(&vpy_path));
    if action != VenvAction::Keep {
        // A rebuild deletes what is there, so it may only start once we know
        // there is something to rebuild WITH. is_real_python filters the
        // Windows Store stub; starting it is what proves the interpreter the
        // user still has is the one this venv lost.
        let base = Path::new(python_bin);
        if !crate::python::is_real_python(python_bin) || !python_starts(base) {
            return Err(no_base_python_message(action));
        }
        if action == VenvAction::Rebuild {
            push_log(state, "The trainer environment is there but its Python does not start any more. Rebuilding it from scratch, your training images and base models are left alone.");
        }
        set_status(state, status_kind, &format!("{tag} (2/4): creating the training environment (venv)..."));
        let mut venv = Command::new(python_bin);
        venv.args(venv_create_args(action)).arg(root.join("venv"));
        run_streamed(venv, "venv create", state, cancel, pid_slot)?;
    }
    let vpy = venv_python(root).to_string_lossy().to_string();

    // 3) torch, routed by the same nvidia-smi probe the ComfyUI installer
    // uses (D#37): Blackwell gets cu128, everything else keeps cu121.
    set_status(state, status_kind, &format!("{tag} (3/4): installing PyTorch into the trainer venv (~2.5 GB, one time)..."));
    let cap = crate::commands::install::detect_nvidia_compute_cap_major();
    let torch_index = torch_index_for_cap(cap);
    push_log(state, &format!(
        "GPU compute capability: {}, PyTorch wheels: {torch_index}",
        cap.map_or("unknown".to_string(), |c| format!("{c}.x")),
    ));
    let mut torch = Command::new(&vpy);
    let mut torch_args = vec!["-m", "pip", "install", "--progress-bar", "off", "--no-input"];
    // A finished but WRONG torch satisfies pip and would never be replaced:
    // cu121 on a Blackwell box, or the half install a repair was called for.
    if cap.is_some_and(|c| c >= 12) || repairing {
        torch_args.push("--force-reinstall");
    }
    torch_args.extend(["torch", "torchvision", "--index-url", torch_index]);
    torch.args(&torch_args);
    run_streamed(torch, "torch install", state, cancel, pid_slot)?;

    // 4) musubi + deps
    set_status(state, status_kind, &format!("{tag} (4/4): installing the trainer package..."));
    let mut pkg = Command::new(&vpy);
    pkg.args(["-m", "pip", "install", "--progress-bar", "off", "--no-input", "-e", "."])
        .current_dir(repo_dir(root));
    run_streamed(pkg, "musubi install", state, cancel, pid_slot)?;
    Ok(())
}

#[tauri::command]
pub fn character_trainer_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let root = trainer_root(&app);
    let comfy = active_comfy_dir(state.inner());
    // File presence only, plus the one thing files cannot tell us. A torch
    // that is on disk but will not import passes every check above, so before
    // trainer_env_broken existed the Set up button stayed hidden in exactly
    // the state that needs it, and the run's error pointed at a button the
    // user could not see.
    let env_ready = venv_python(&root).exists()
        && repo_dir(&root).join("src").exists()
        && torch_installed(&root)
        && musubi_installed(&root)
        && !state.trainer_env_broken.load(Ordering::SeqCst);
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
    // Held for the run's own repair path below: rebuilding the venv needs the
    // system python, not the venv one that may be the broken part.
    let python_bin = state.python_bin.lock().unwrap().clone();
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
    let env_broken = state.trainer_env_broken.clone();
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

        // 0) preflight, and then repair rather than refuse. All three failure
        // classes used to pass every disk check and die mid-run as a raw error
        // the UI could not explain, and the only cure we offered was a Set up
        // button that did not render once the environment counted as ready
        // (bob80817 D#102 with a stale cu121 torch, sockenmonster with an
        // install that stopped before the trainer package). The customer
        // should not need install instructions, so the run fixes its own
        // environment and carries on.
        let probe_env = |label: &str| -> Preflight {
            let mut probe = Command::new(&vpy_s);
            probe.args(["-c", TORCH_PREFLIGHT_PY]);
            force_python_utf8(&mut probe);
            #[cfg(target_os = "windows")]
            probe.creation_flags(CREATE_NO_WINDOW);
            match probe.output() {
                Ok(out) => preflight_verdict(
                    out.status.success(),
                    &String::from_utf8_lossy(&out.stdout),
                    &String::from_utf8_lossy(&out.stderr),
                ),
                Err(e) => Preflight::TorchBroken(format!("could not run the trainer python ({label}): {e}")),
            }
        };

        set_status(&run, "running", "Checking the training environment...");
        let verdict = probe_env("first check");
        if !verdict.is_ok() {
            push_log(&run, &verdict.message());
            push_log(&run, "Repairing it now, no action needed. Your training images and base models are left alone.");
            let force = verdict.needs_torch_reinstall();
            if let Err(e) = provision_trainer_env(&root, &python_bin, force, &run, "running", &cancel, &pid_slot) {
                set_status(&run, if e == "cancelled" { "cancelled" } else { "error" }, &e);
                return;
            }
            // Only a SECOND failure is a dead end. Report what is still wrong
            // plus the tail of the repair log, so the message names the cause
            // instead of the symptom.
            let after = probe_env("after repair");
            if !after.is_ok() {
                let tail = run.lock().ok()
                    .map(|st| st.logs.iter().rev().take(8).rev().cloned().collect::<Vec<_>>().join(" | "))
                    .unwrap_or_default();
                // The disk still LOOKS installed, so say out loud that it is
                // not, otherwise the Set up button this message points at
                // stays hidden and the customer is back where they started.
                env_broken.store(true, Ordering::SeqCst);
                set_status(&run, "error", &repair_failed_message(&after, &tail));
                return;
            }
            env_broken.store(false, Ordering::SeqCst);
            push_log(&run, "Trainer environment repaired, starting the run.");
        } else {
            env_broken.store(false, Ordering::SeqCst);
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
        "phase": run.phase,
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
        use super::{preflight_verdict, Preflight};
        let v = preflight_verdict(
            false,
            "",
            "Traceback (most recent call last):\nModuleNotFoundError: No module named 'torch'",
        );
        assert_eq!(
            v,
            Preflight::TorchBroken("ModuleNotFoundError: No module named 'torch'".into())
        );
        assert!(v.message().contains("No module named 'torch'"));
        assert!(v.needs_torch_reinstall());
    }

    #[test]
    fn preflight_names_the_kernel_gap_on_blackwell_with_cu121() {
        use super::{preflight_verdict, Preflight};
        let out = "TORCH_OK 2.3.1+cu121\nCAP 12 0\nARCHS sm_50 sm_60 sm_70 sm_75 sm_80 sm_86 sm_90\nMUSUBI_OK\n";
        let v = preflight_verdict(true, out, "");
        assert_eq!(v, Preflight::KernelsTooOld { cap: 12, max: 9 });
        assert!(v.message().contains("compute capability 12.x"));
        assert!(v.message().contains("no kernels"));
        // The wrong build is already installed, so pip has to be forced.
        assert!(v.needs_torch_reinstall());
    }

    #[test]
    fn preflight_catches_the_trainer_package_a_healthy_torch_hides() {
        use super::{preflight_verdict, Preflight};
        // sockenmonster: the install died between torch and `pip install -e .`.
        // torch imports, CUDA is fine, and the run still cannot start.
        let out = "TORCH_OK 2.7.0+cu128\nCAP 8 6\nARCHS sm_80 sm_86 sm_90\n";
        let v = preflight_verdict(true, out, "");
        assert_eq!(v, Preflight::PackageMissing);
        assert!(v.message().contains("musubi_tuner"));
        // Nothing is wrong with torch here, so it must not be reinstalled.
        assert!(!v.needs_torch_reinstall());
    }

    #[test]
    fn preflight_passes_on_a_matching_build_and_on_cpu_only() {
        use super::preflight_verdict;
        let ok = "TORCH_OK 2.7.0+cu128\nCAP 12 0\nARCHS sm_80 sm_90 sm_100 sm_120 compute_120\nMUSUBI_OK\n";
        assert!(preflight_verdict(true, ok, "").is_ok());
        assert!(preflight_verdict(true, "TORCH_OK 2.3.1\nMUSUBI_OK\n", "").is_ok());
    }

    #[test]
    fn negative_control_the_old_verdict_called_the_package_gap_healthy() {
        use super::{preflight_verdict, Preflight};
        // The old rule was "torch imports and the kernels fit, therefore ready".
        // Replayed on sockenmonster's environment it says ready; the new one
        // does not. This is the whole of the bug in two lines.
        let out = "TORCH_OK 2.7.0+cu128\nCAP 8 6\nARCHS sm_80 sm_86 sm_90\n";
        let old_rule_says_ready = out.contains("TORCH_OK");
        assert!(old_rule_says_ready);
        assert_ne!(preflight_verdict(true, out, ""), Preflight::Ok);
    }

    #[test]
    fn the_probe_script_prints_every_marker_the_verdict_reads() {
        use super::TORCH_PREFLIGHT_PY;
        // A marker renamed on one side only would silently turn every run into
        // a repair loop, so the two are pinned against each other here.
        for marker in ["TORCH_OK", "CAP", "ARCHS", "MUSUBI_OK"] {
            assert!(TORCH_PREFLIGHT_PY.contains(marker), "probe never prints {marker}");
        }
        // find_spec, not import: importing pulls the whole training stack.
        assert!(TORCH_PREFLIGHT_PY.contains("find_spec('musubi_tuner')"));
    }

    #[test]
    fn env_is_not_ready_until_the_trainer_package_is_there_too() {
        use super::{musubi_installed, torch_installed};
        use std::fs;
        let root = std::env::temp_dir().join(format!("lu-trainer-musubi-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let sp = root.join("venv").join("Lib").join("site-packages");
        fs::create_dir_all(&sp).unwrap();

        // torch landed, the trainer package did not: counted as ready before.
        let torch = sp.join("torch");
        fs::create_dir_all(&torch).unwrap();
        fs::write(torch.join("version.py"), "__version__ = '2.7.0'").unwrap();
        assert!(torch_installed(&root));
        assert!(!musubi_installed(&root));

        // `pip install -e .` leaves a dist-info plus an __editable__ .pth,
        // never a package directory, so the marker has to accept those.
        fs::create_dir_all(sp.join("musubi_tuner-0.1.0.dist-info")).unwrap();
        assert!(musubi_installed(&root));

        let root2 = std::env::temp_dir().join(format!("lu-trainer-musubi-pth-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root2);
        let sp2 = root2.join("venv").join("lib").join("python3.11").join("site-packages");
        fs::create_dir_all(&sp2).unwrap();
        assert!(!musubi_installed(&root2));
        fs::write(sp2.join("__editable__.musubi_tuner-0.1.0.pth"), "/src").unwrap();
        assert!(musubi_installed(&root2));

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&root2);
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

    // ── a venv that is present but dead (review 2026-08-14) ─────────────────
    //
    // Windows user upgrades Python 3.11 to 3.13 and uninstalls the old one.
    // `venv\Scripts\python.exe` is a real copied binary, so it is still there
    // and still passes exists(), but it aborts during interpreter init because
    // pyvenv.cfg names a home that is gone. The old step 2 asked only about
    // presence, so the repair kept the dead venv and drove the two pip steps
    // with it, and the run died as "torch install failed (exit 103)". It could
    // never recover: start_character_training refuses to reach the repair
    // unless that same file exists, so on the repair path the old guard was
    // false every single time, and the Set up button stays hidden because the
    // status probe counts files too.

    #[test]
    fn a_venv_whose_python_no_longer_starts_gets_rebuilt() {
        use super::{venv_action, venv_create_args, VenvAction};
        assert_eq!(venv_action(true, false), VenvAction::Rebuild);
        // A rebuild must clear: the old site-packages belongs to an
        // interpreter that no longer exists, and pip would repair on top of it.
        assert_eq!(venv_create_args(VenvAction::Rebuild), ["-m", "venv", "--clear"]);
    }

    #[test]
    fn a_working_venv_is_kept_and_a_missing_one_is_created() {
        use super::{venv_action, venv_create_args, VenvAction};
        assert_eq!(venv_action(true, true), VenvAction::Keep);
        assert_eq!(venv_action(false, false), VenvAction::Create);
        // POSIX: venv/bin/python is a symlink, so a dead base already shows up
        // as absent. That is why this only ever bit Windows.
        assert_eq!(venv_action(false, true), VenvAction::Create);
        assert_eq!(venv_create_args(VenvAction::Create), ["-m", "venv"]);
        assert_eq!(venv_create_args(VenvAction::Keep), ["-m", "venv"]);
    }

    #[test]
    fn presence_alone_never_counts_as_a_working_interpreter() {
        use super::python_starts;
        let dir = std::env::temp_dir().join("lu-trainer-venv-probe");
        let _ = std::fs::create_dir_all(&dir);
        let fake = dir.join("python-not-an-interpreter");
        std::fs::write(&fake, b"pyvenv.cfg points at a home that is gone").unwrap();
        assert!(fake.exists(), "the file is there, which is all the old check asked");
        assert!(!python_starts(&fake), "but it does not run, which is the question");
        assert!(!python_starts(&dir.join("nothing-here")));
        let _ = std::fs::remove_file(&fake);
    }

    #[test]
    fn a_rebuild_without_a_base_python_explains_itself_instead_of_wiping_the_venv() {
        use super::{no_base_python_message, VenvAction};
        let rebuild = no_base_python_message(VenvAction::Rebuild);
        assert!(rebuild.contains("does not start any more"));
        assert!(rebuild.contains("Install Python in Settings"));
        // The fresh-install case must not claim there is an environment.
        let create = no_base_python_message(VenvAction::Create);
        assert!(!create.contains("still there"));
        assert!(create.contains("Install Python in Settings"));
    }

    #[test]
    fn step_two_asks_whether_the_venv_runs_not_whether_it_exists() {
        // Same guard as the state.rs one below: the whole fix is which
        // question step 2 asks, and a revert to exists() would pass every
        // other test in this file.
        let src = include_str!("trainer.rs");
        let step2 = &src[src.find("    // 2) venv").expect("step 2 marker")..];
        let step2 = &step2[..step2.find("// 3) torch").expect("step 3 marker")];
        assert!(
            step2.contains("venv_action(exists, exists && python_starts(&vpy_path))"),
            "step 2 must decide with venv_action, not with a bare exists()",
        );
        assert!(
            !step2.contains("if !venv_python(root).exists()"),
            "the presence-only guard is back",
        );
        assert!(
            step2.contains("venv_create_args(action)"),
            "a rebuild has to pass --clear, which only venv_create_args does",
        );
    }

    // ── a dead end has to name the way out (review 2026-08-14) ──────────────
    //
    // The repair fails a second time on an offline machine or a full disk.
    // Preflight::message() was rewritten as a pure diagnosis, and the
    // instruction the pre-A2 text carried ("Run the trainer install again from
    // Character Studio") was not replaced anywhere, so the customer was left
    // with a verdict and a pip log tail. Worse, the readiness probe is a
    // file-presence check: a torch that is on disk but will not import still
    // counts as ready, so the Set up button was not even on screen.

    #[test]
    fn the_terminal_message_says_what_to_do_next() {
        use super::{repair_failed_message, Preflight};
        let msg = repair_failed_message(
            &Preflight::TorchBroken("No module named 'torch'".into()),
            "pip install torch | connection reset",
        );
        assert!(msg.contains("PyTorch is missing or broken"), "keeps the diagnosis");
        assert!(msg.contains("The automatic repair did not fix it."), "says it already tried");
        assert!(msg.contains("Set up trainer"), "names the button, verbatim as the UI labels it");
        assert!(msg.contains("online") && msg.contains("room"), "names the two usual blockers");
        assert!(msg.ends_with("Last steps: pip install torch | connection reset"), "log tail last");
    }

    #[test]
    fn every_failure_class_carries_a_next_step_and_a_healthy_one_does_not() {
        use super::Preflight;
        for v in [
            Preflight::TorchBroken("x".into()),
            Preflight::KernelsTooOld { cap: 12, max: 9 },
            Preflight::PackageMissing,
        ] {
            assert!(v.next_step().contains("Set up trainer"), "{v:?} has no way out");
        }
        assert_eq!(Preflight::Ok.next_step(), "");
    }

    #[test]
    fn a_failed_repair_makes_the_environment_report_as_not_ready() {
        // The button the message points at only renders on envReady false, and
        // the file checks alone cannot see a broken interpreter or a torch
        // that imports nothing. Source-pinned for the same reason as the
        // state.rs guard below: the whole fix is this one `&&`.
        let src = include_str!("trainer.rs");
        let status = &src[src.find("pub fn character_trainer_status").expect("status fn")..];
        let status = &status[..status.find("\"basesReady\"").expect("json body")];
        assert!(
            status.contains("&& !state.trainer_env_broken.load(Ordering::SeqCst)"),
            "envReady no longer folds in the failed repair",
        );
        // And it must be cleared again, or one bad run hides the trainer for
        // the rest of the session.
        assert!(src.contains("env_broken.store(false, Ordering::SeqCst)"));
        assert!(src.contains("env_broken.store(true, Ordering::SeqCst)"));
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
