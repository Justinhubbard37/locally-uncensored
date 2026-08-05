use base64::Engine;
use sysinfo::System;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Disk-space preflight shim for `commands::video::video_install_model`
/// (originally the bridge's statvfs-based free/total/used probe). Not wired up
/// to a real disk-usage check here — returning `None` makes the preflight a
/// no-op (video installs proceed without a disk-space guard, same as every
/// other model-download path in this codebase, none of which check free space
/// today). Signature (`Option<(free, total, used)>` in bytes) matches the call
/// site's `if let Some((free, _, _)) = ...` destructure.
#[allow(dead_code)]
pub fn volume_space_for(_path: &std::path::Path) -> Option<(u64, u64, u64)> {
    None
}

#[tauri::command]
pub fn system_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "hostname": hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_default(),
        "username": whoami::username(),
        "totalMemory": System::new_all().total_memory(),
        "cpuCount": num_cpus::get(),
    }))
}

#[tauri::command]
pub fn process_list() -> Result<serde_json::Value, String> {
    let mut sys = System::new_all();
    sys.refresh_all();

    let mut processes: Vec<serde_json::Value> = sys
        .processes()
        .values()
        .map(|p| {
            serde_json::json!({
                "name": p.name().to_string_lossy(),
                "pid": p.pid().as_u32(),
                "memory": p.memory(),
                "cpu": p.cpu_usage(),
            })
        })
        .collect();

    // Sort by memory desc, limit to top 50
    processes.sort_by(|a, b| {
        b.get("memory")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .cmp(
                &a.get("memory")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
            )
    });
    processes.truncate(50);

    Ok(serde_json::json!({ "processes": processes, "count": processes.len() }))
}

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread,
// so every millisecond spent here is a frozen window. Same treatment
// `lmstudio_server_status` already got — this one was simply missed.
#[tauri::command]
pub async fn screenshot() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(screenshot_blocking)
        .await
        .map_err(|e| format!("screenshot task: {e}"))?
}

fn screenshot_blocking() -> Result<serde_json::Value, String> {
    // Unique per call. The capture used to land on a fixed `lu-screenshot.png`,
    // and TWO callers reach this: the agent's screenshot tool and the phone
    // bridge (remote.rs). Overlapping calls read each other's half-written PNG,
    // or one deleted the file the other was about to read ("Read screenshot: no
    // such file"), or a caller simply got the other one's screen.
    let tmp = std::env::temp_dir().join(format!("lu-screenshot-{}.png", uuid::Uuid::new_v4()));
    let captured = capture_screen_to(&tmp)
        .and_then(|()| std::fs::read(&tmp).map_err(|e| format!("Read screenshot: {}", e)));
    // Always — the old code returned early on a read error and left a full
    // picture of the user's screen sitting in the temp directory.
    let _ = std::fs::remove_file(&tmp);

    let b64 = base64::engine::general_purpose::STANDARD.encode(&captured?);
    Ok(serde_json::json!({ "image": b64, "format": "png", "encoding": "base64" }))
}

/// Quote a path for a PowerShell SINGLE-quoted string literal: only `'` is
/// special there, and it escapes by doubling.
///
/// The old code doubled BACKSLASHES instead, which is C/JSON escaping, not
/// PowerShell — inside single quotes that produced a literal `C:\\Users\\…`
/// and only worked because Windows collapses repeated separators. It also left
/// `'` untouched, so any user whose profile contains an apostrophe
/// (C:\Users\O'Brien\AppData\Local\Temp) ended the string early and the script
/// died with a parse error.
// Only the Windows capture path calls this; its tests run on every platform.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn ps_single_quoted(s: &str) -> String {
    s.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn capture_screen_to(tmp: &std::path::Path) -> Result<(), String> {
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
        $bitmap.Save('{}')
        $graphics.Dispose()
        $bitmap.Dispose()
        "#,
        ps_single_quoted(&tmp.to_string_lossy())
    );

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("Screenshot failed: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Screenshot failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

// macOS: the native `screencapture` CLI. `-x` = silent (no shutter sound),
// `-t png` = PNG. Needs the app to hold Screen Recording permission (TCC);
// without it screencapture exits non-zero ("could not create image from
// display") and writes nothing, so give an actionable hint instead of a
// generic failure.
#[cfg(target_os = "macos")]
fn capture_screen_to(tmp: &std::path::Path) -> Result<(), String> {
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-t", "png"])
        .arg(tmp)
        .status()
        .map_err(|e| format!("Screenshot failed: {}", e))?;
    if !status.success() || !tmp.exists() {
        return Err("Screenshot failed — grant LU the Screen Recording permission in System Settings ▸ Privacy & Security ▸ Screen Recording, then try again.".to_string());
    }
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn capture_screen_to(_tmp: &std::path::Path) -> Result<(), String> {
    Err("Screenshot not implemented for this platform yet".to_string())
}

#[tauri::command]
pub async fn pick_folder(default_path: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(ref p) = default_path {
        dialog = dialog.set_directory(p);
    }
    let result = dialog.pick_folder().await;
    Ok(result.map(|f| f.path().to_string_lossy().to_string()))
}

/// Exit the app — used by the auto-updater to let the NSIS installer swap
/// the binary, and by any future "full quit" UI affordance.
///
/// Live-tested on 2026-05-25: Tauri v2's `app.exit(0)` returns from the run
/// loop without dropping the managed `AppState` on Windows, so subprocess
/// children (Ollama, ComfyUI, Claude Code) survived every "graceful" quit
/// path. We work around it by explicitly running the shutdown chain BEFORE
/// asking Tauri to exit. This is what makes kj103x's Ollama-orphan fix
/// (v2.4.9, Discord 2026-05-23) actually deliver on the tray-Quit + auto-
/// updater paths in the released binary.
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        state.shutdown_subprocesses();
    }
    app.exit(0);
}

/// Get the persistent settings dir — outside the (NSIS) install dir so it
/// survives updates. On Windows this stays `%APPDATA%/Locally Uncensored` (the
/// path existing installs already back up to). `APPDATA` is Windows-only, so on
/// macOS/Linux the whole backup/restore + onboarding-marker cluster used to
/// hard-error; there we use the shared app data dir instead.
fn persistent_dir() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").map_err(|_| "APPDATA not set".to_string())?;
        Ok(std::path::PathBuf::from(appdata).join("Locally Uncensored"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(crate::os_paths::data_dir().join("stores"))
    }
}

/// Backup all localStorage stores to %APPDATA% (survives NSIS updates)
/// Uses atomic write (temp file + rename) to prevent corruption on crash
#[tauri::command]
pub fn backup_stores(data: String) -> Result<(), String> {
    let dir = persistent_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join("store_backup.json");
    let tmp = dir.join("store_backup.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(())
}

/// Restore stores from %APPDATA% backup
#[tauri::command]
pub fn restore_stores() -> Result<Option<String>, String> {
    let path = persistent_dir()?.join("store_backup.json");
    if path.exists() {
        let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok(Some(data))
    } else {
        Ok(None)
    }
}

/// Backup the IndexedDB RAG chunks (embedding vectors) to %APPDATA%.
///
/// The chat-persistence triad (`store_backup.json`) only covers localStorage
/// stores. RAG embedding chunks live in IndexedDB under
/// `locally-uncensored-rag → chunks` because the 768-float vectors blow past
/// localStorage's ~10 MB quota for any non-trivial document. After an NSIS
/// upgrade or WebView2 data reset, localStorage restores the document
/// metadata but the IndexedDB chunks were silently lost — every "RAG enabled"
/// chat would show the document name + remain non-searchable.
///
/// kj103x report (Discord 2026-05-23, #help-chat thread 1507756765612216411,
/// running v2.4.8): "is there a way to keep chats with the plugins and the
/// attached documents via RAG when i close the app and reopen it?" References
/// Discussion #26 as "'fixed' but not really fixed" — the v2.3.4 fix was the
/// chat-message half; this commit is the RAG embeddings half.
///
/// The payload is the JSON-serialized snapshot of every objectStore entry
/// (the frontend uses `getAll()` on the chunks store and `JSON.stringify`s
/// the map `documentId → TextChunk[]`). Same atomic-temp-rename pattern as
/// `backup_stores` so a crash mid-write doesn't truncate a previous backup.
#[tauri::command]
pub fn backup_rag_chunks(data: String) -> Result<(), String> {
    let dir = persistent_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join("rag_chunks_backup.json");
    let tmp = dir.join("rag_chunks_backup.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(())
}

/// Restore RAG chunks (counterpart to `backup_rag_chunks`). Returns the JSON
/// payload (same shape: `Record<documentId, TextChunk[]>`) or `None` when no
/// backup exists yet. The frontend writes each entry back into IndexedDB on
/// cold start so RAG retrieval works after WebView2 data is wiped.
#[tauri::command]
pub fn restore_rag_chunks() -> Result<Option<String>, String> {
    let path = persistent_dir()?.join("rag_chunks_backup.json");
    if path.exists() {
        let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok(Some(data))
    } else {
        Ok(None)
    }
}

/// Check if onboarding was completed (marker file in %APPDATA%, survives NSIS updates)
#[tauri::command]
pub fn is_onboarding_done() -> bool {
    persistent_dir()
        .map(|dir| dir.join("onboarding_done").exists())
        .unwrap_or(false)
}

/// Persist onboarding completion to %APPDATA% (outside NSIS install dir).
/// Pass `done: false` to clear the marker so the first-launch wizard runs again.
#[tauri::command]
pub fn set_onboarding_done(done: Option<bool>) -> Result<(), String> {
    let dir = persistent_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("onboarding_done");
    if done.unwrap_or(true) {
        std::fs::write(&path, "1").map_err(|e| e.to_string())?;
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Return the current local date/time/timezone. Agents should call this
/// instead of googling "what day is it" — the info is free and exact.
///
/// This used to shell out (`powershell (Get-Date).ToString('zzz')` on Windows,
/// `date +%z` elsewhere) purely to learn the UTC offset, on the main thread,
/// on EVERY call — and the tool sits in ALWAYS_INCLUDE, so the model may call
/// it any turn. A PowerShell cold start is 300-900 ms, more with an AV hooked
/// into process creation, and the window is frozen for all of it. Worse, when
/// the spawn failed the offset silently fell back to 0, so the agent reported
/// UTC as the user's local time.
///
/// chrono was already in the dependency tree (via jsonwebtoken, with the
/// `clock` feature and iana-time-zone resolved), so reading the real offset
/// in-process costs no new crate and no process at all.
#[tauri::command]
pub fn get_current_time() -> Result<serde_json::Value, String> {
    use chrono::{Offset, Utc};

    let local = chrono::Local::now();
    let utc = local.with_timezone(&Utc);
    let offset_minutes = local.offset().fix().local_minus_utc() / 60;

    Ok(serde_json::json!({
        "unix":            utc.timestamp(),
        "iso_local":       local.format("%Y-%m-%d %H:%M:%S").to_string(),
        "iso_utc":         utc.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        "timezone":        local.format("%z").to_string(),
        "timezone_offset": offset_minutes,
    }))
}

// ── Opening folders and launching apps (B1, Morgan 2026-08-03) ──────────────
//
// Morgan asked for an agent that can open a folder and start a program. The
// deliberate limits, because this is a tool a MODEL calls, not a person:
//
//   * `desktop_open` opens only what already EXISTS on disk. A path that does
//     not resolve is refused, which is what keeps this from doubling as a
//     protocol-handler primitive: `https://…`, `file://…` and `mailto:` are not
//     paths, so they never reach the opener. Web pages have web_fetch, and the
//     UI has its own openExternal with a URL allowlist.
//   * `app_launch` takes a name and nothing else. No arguments, by design: an
//     app plus attacker-chosen argv is a different and much larger surface than
//     "start Notepad", and nothing in Morgan's request needs it.
//   * Neither builds a shell string by concatenation. Every value goes in as
//     its own argv entry, so a path with a space, a quote or a semicolon is
//     data. The one platform path that cannot avoid a shell (the Windows
//     `cmd /C start` fallback) is reached only after the name has passed
//     `validate_app_name`.

/// Characters that let a name break out of a Windows `cmd /C` line. An
/// application is called "Google Chrome", never "foo & del".
const APP_NAME_FORBIDDEN: &[char] = &['&', '|', ';', '<', '>', '^', '"', '\'', '`', '\n', '\r', '%', '!'];

/// An app name has to be a name. Rejecting rather than escaping keeps the rule
/// readable and the same on all three platforms.
fn validate_app_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("app_launch: no application name given".into());
    }
    if trimmed.len() > 256 {
        return Err("app_launch: application name is too long".into());
    }
    if let Some(bad) = trimmed.chars().find(|c| APP_NAME_FORBIDDEN.contains(c)) {
        return Err(format!(
            "app_launch: refused, the name contains {bad:?}. Pass a plain application name such as \"Notepad\" or \"Google Chrome\"."
        ));
    }
    Ok(())
}

/// Resolve and verify the target of `desktop_open`. Returns the existing path
/// and whether it is a directory.
fn resolve_existing(path: &str) -> Result<(std::path::PathBuf, bool), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("desktop_open: no path given".into());
    }
    // A URL is not a path. Naming the case explicitly gives the model a usable
    // error instead of "no such file or directory" on a string it thinks is fine.
    if let Some(scheme) = trimmed.split("://").next().filter(|s| *s != trimmed) {
        return Err(format!(
            "desktop_open: {scheme}:// is a URL, not a path. This tool opens folders and files that exist on this machine."
        ));
    }
    let p = std::path::PathBuf::from(trimmed);
    let meta = std::fs::metadata(&p)
        .map_err(|e| format!("desktop_open: cannot open {trimmed}: {e}"))?;
    Ok((p, meta.is_dir()))
}

/// Open a folder or file in the desktop environment, or reveal it in the file
/// manager with the item selected.
#[tauri::command]
pub fn desktop_open(path: String, reveal: Option<bool>) -> Result<serde_json::Value, String> {
    let (target, is_dir) = resolve_existing(&path)?;
    let reveal = reveal.unwrap_or(false);
    let shown = target.to_string_lossy().to_string();
    let mut cmd: std::process::Command;

    #[cfg(target_os = "macos")]
    {
        cmd = std::process::Command::new("open");
        if reveal {
            cmd.arg("-R");
        }
        cmd.arg(&target);
    }

    #[cfg(target_os = "windows")]
    {
        cmd = std::process::Command::new("explorer");
        if reveal {
            // explorer takes this as ONE argument: `/select,C:\path`.
            let mut sel = std::ffi::OsString::from("/select,");
            sel.push(target.as_os_str());
            cmd.arg(sel);
        } else {
            cmd.arg(&target);
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No portable "reveal" on Linux, so revealing a file opens the folder
        // that holds it. Saying so beats silently doing something else.
        let opened = if reveal && !is_dir {
            target.parent().unwrap_or(&target).to_path_buf()
        } else {
            target.clone()
        };
        cmd = std::process::Command::new("xdg-open");
        cmd.arg(&opened);
    }

    crate::process_util::suppress_window(&mut cmd);
    let status = cmd
        .status()
        .map_err(|e| format!("desktop_open: could not start the file manager: {e}"))?;

    // Windows Explorer reports a non-zero exit even when it did the right
    // thing, so its code says nothing about success and is not checked.
    #[cfg(not(target_os = "windows"))]
    if !status.success() {
        return Err(format!("desktop_open: the file manager refused {shown}"));
    }
    #[cfg(target_os = "windows")]
    let _ = status;

    Ok(serde_json::json!({
        "path": shown,
        "kind": if is_dir { "folder" } else { "file" },
        "revealed": reveal,
    }))
}

/// Launch an installed application by name. No arguments are forwarded.
#[tauri::command]
pub fn app_launch(name: String) -> Result<serde_json::Value, String> {
    validate_app_name(&name)?;
    let name = name.trim().to_string();

    #[cfg(target_os = "macos")]
    {
        // `open -a` searches the launch services database, so "Chrome",
        // "Google Chrome" and a full .app path all resolve.
        let mut cmd = std::process::Command::new("open");
        cmd.arg("-a").arg(&name);
        let out = cmd
            .output()
            .map_err(|e| format!("app_launch: could not run open: {e}"))?;
        if !out.status.success() {
            let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(format!(
                "app_launch: could not start {name}. {}",
                if why.is_empty() { "It may not be installed.".into() } else { why }
            ));
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // A name that is already an executable on PATH (or a full path to one)
        // needs no shell at all, so that is tried first.
        let mut direct = std::process::Command::new(&name);
        crate::process_util::suppress_window(&mut direct);
        if direct.spawn().is_ok() {
            return Ok(serde_json::json!({ "launched": name }));
        }

        #[cfg(target_os = "windows")]
        let mut cmd = {
            // `start` is a cmd builtin, so this is the one path that needs a
            // shell. The empty "" is start's title argument: without it start
            // treats a quoted name AS the title and opens a console instead.
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "start", "", &name]);
            c
        };
        #[cfg(all(unix, not(target_os = "macos")))]
        let mut cmd = {
            // Desktop entries are how Linux names applications.
            let mut c = std::process::Command::new("gtk-launch");
            c.arg(&name);
            c
        };

        crate::process_util::suppress_window(&mut cmd);
        let status = cmd
            .status()
            .map_err(|e| format!("app_launch: could not start {name}: {e}"))?;
        if !status.success() {
            return Err(format!(
                "app_launch: could not start {name}. It may not be installed under that name."
            ));
        }
    }

    Ok(serde_json::json!({ "launched": name }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The old implementation spawned a process for the UTC offset and fell
    /// back to 0 when that failed, so it could report UTC as local time. These
    /// assert the three values stay consistent with each other.
    /// Two callers reach the screenshot tool (agent + phone bridge). A fixed
    /// temp name meant they clobbered each other; the name must differ per call
    /// and the file must be gone afterwards.
    #[test]
    fn every_screenshot_gets_its_own_temp_file() {
        let seen: std::collections::HashSet<String> = (0..50)
            .map(|_| format!("lu-screenshot-{}.png", uuid::Uuid::new_v4()))
            .collect();
        assert_eq!(seen.len(), 50);

        // The capture fails on this platform, but the temp file must still be
        // cleaned up rather than left behind on the early return.
        let before = std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("lu-screenshot-"))
            .count();
        let _ = screenshot_blocking();
        let after = std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("lu-screenshot-"))
            .count();
        assert_eq!(before, after, "screenshot left a temp file behind");
    }

    /// PowerShell single-quoted strings escape `'` by doubling it, and treat a
    /// backslash as an ordinary character. C:\Users\O'Brien used to end the
    /// string early and kill the script.
    #[test]
    fn powershell_paths_survive_an_apostrophe() {
        assert_eq!(
            ps_single_quoted(r"C:\Users\O'Brien\AppData\Local\Temp\a.png"),
            r"C:\Users\O''Brien\AppData\Local\Temp\a.png"
        );
        // A plain path is passed through untouched — no backslash doubling.
        assert_eq!(ps_single_quoted(r"C:\Users\dave\a.png"), r"C:\Users\dave\a.png");
    }

    #[test]
    fn current_time_is_internally_consistent() {
        let v = get_current_time().expect("get_current_time");
        let unix = v["unix"].as_i64().unwrap();
        let offset_min = v["timezone_offset"].as_i64().unwrap();

        // Local wall clock must be exactly `offset` minutes ahead of UTC.
        let utc = chrono::DateTime::parse_from_rfc3339(v["iso_utc"].as_str().unwrap())
            .expect("iso_utc parses as RFC3339");
        let local = chrono::NaiveDateTime::parse_from_str(
            v["iso_local"].as_str().unwrap(),
            "%Y-%m-%d %H:%M:%S",
        )
        .expect("iso_local parses");
        let delta_min = (local - utc.naive_utc()).num_minutes();
        assert_eq!(delta_min, offset_min, "local clock must be utc + offset");

        assert_eq!(utc.timestamp(), unix, "iso_utc must match the unix field");

        // "+0200" / "-0500" — the shape the agent prompt documents.
        let tz = v["timezone"].as_str().unwrap();
        assert!(
            tz.len() == 5 && (tz.starts_with('+') || tz.starts_with('-'))
                && tz[1..].chars().all(|c| c.is_ascii_digit()),
            "unexpected timezone format: {tz}"
        );
    }

    #[test]
    fn current_time_costs_no_process_spawn() {
        // Measured: the old `date +%z` path cost 36.8 ms for 20 calls on this
        // Mac, and a PowerShell cold start on Windows is 300-900 ms EACH. In
        // process it is microseconds, so 20 ms fails either spawn path while
        // leaving plenty of room on a loaded box.
        let started = std::time::Instant::now();
        for _ in 0..20 {
            let _ = get_current_time().unwrap();
        }
        assert!(
            started.elapsed() < std::time::Duration::from_millis(20),
            "20 calls took {:?} — is something spawning a process again?",
            started.elapsed()
        );
    }

    // ── B1: opening folders and launching apps ──────────────────

    #[test]
    fn an_ordinary_application_name_passes() {
        for name in ["Notepad", "Google Chrome", "Visual Studio Code", "firefox", "calc.exe"] {
            assert!(validate_app_name(name).is_ok(), "rejected a real name: {name}");
        }
    }

    #[test]
    fn a_name_that_could_break_out_of_a_command_line_is_refused() {
        // The Windows fallback ends up in `cmd /C start`, so every character
        // that means something to cmd has to be gone before we get there.
        for name in [
            "Notepad & del C:\\Windows\\*",
            "foo | whoami",
            "foo; rm -rf ~",
            "foo > out.txt",
            "foo`whoami`",
            "foo\nshutdown",
            "%USERPROFILE%",
            "foo^&bar",
        ] {
            assert!(validate_app_name(name).is_err(), "let a payload through: {name}");
        }
    }

    #[test]
    fn an_empty_or_oversized_name_is_refused() {
        assert!(validate_app_name("").is_err());
        assert!(validate_app_name("   ").is_err());
        assert!(validate_app_name(&"a".repeat(300)).is_err());
    }

    #[test]
    fn a_url_is_not_a_path_and_says_so() {
        // The rule that keeps desktop_open from becoming a way to make the
        // machine follow a link the model chose.
        for url in ["https://example.com", "file:///etc/passwd", "mailto:a@b.c"] {
            let err = resolve_existing(url).unwrap_err();
            assert!(
                err.contains("URL") || err.contains("cannot open"),
                "unhelpful error for {url}: {err}"
            );
        }
        assert!(resolve_existing("https://example.com").unwrap_err().contains("URL"));
    }

    #[test]
    fn a_path_that_does_not_exist_is_refused() {
        let missing = std::env::temp_dir().join("lu-nope-4f1c9a2b").to_string_lossy().to_string();
        assert!(resolve_existing(&missing).is_err());
        assert!(resolve_existing("").is_err());
    }

    #[test]
    fn an_existing_folder_resolves_and_is_reported_as_a_folder() {
        let dir = std::env::temp_dir();
        let (path, is_dir) = resolve_existing(&dir.to_string_lossy()).unwrap();
        assert!(is_dir, "temp dir should be a directory");
        assert!(path.exists());
    }

    #[test]
    fn an_existing_file_resolves_and_is_reported_as_a_file() {
        let f = std::env::temp_dir().join("lu-open-probe.txt");
        std::fs::write(&f, b"probe").unwrap();
        let (_, is_dir) = resolve_existing(&f.to_string_lossy()).unwrap();
        assert!(!is_dir, "a regular file must not report as a folder");
        let _ = std::fs::remove_file(&f);
    }

    #[test]
    fn a_path_with_spaces_and_quotes_survives_resolution() {
        // Nothing here concatenates a command line, so a hostile-looking name
        // is just a name. This is the test that would fail the day someone
        // rewrites the opener to build a shell string.
        let dir = std::env::temp_dir().join("lu probe; rm -rf $HOME");
        std::fs::create_dir_all(&dir).unwrap();
        let (path, is_dir) = resolve_existing(&dir.to_string_lossy()).unwrap();
        assert!(is_dir);
        assert!(path.to_string_lossy().contains("rm -rf"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
