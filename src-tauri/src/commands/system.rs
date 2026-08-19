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

/// How long a screen capture may take before we stop waiting for it.
///
/// G28 (Mac, R01a, 2026-08-07): the agent's `screenshot` step took 138
/// SECONDS. macOS shows its Screen Recording consent dialog and holds
/// `/usr/sbin/screencapture` until somebody answers it, and `.status()` waits
/// forever by definition. An interactive agent run cannot stand still for two
/// minutes on a picture of the screen. 20 s is far above a real capture (tens
/// of milliseconds, seconds at worst on a huge display) and far below the
/// wait a blocked consent dialog imposes.
const SCREENSHOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Run a capture command with a deadline. `Ok(())` only when it exited zero in
/// time; the process is killed on timeout so no orphan sits on the display
/// server. Exported for the unit test, which is the only honest way to prove
/// the deadline fires without a consent dialog to hand.
pub(crate) fn run_capture_bounded(
    mut cmd: std::process::Command,
    max: std::time::Duration,
    timeout_msg: &str,
) -> Result<(), String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Screenshot failed: {}", e))?;
    let deadline = std::time::Instant::now() + max;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("Screenshot failed: the capture command exited with an error.".to_string())
                }
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(timeout_msg.to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(e) => return Err(format!("Screenshot failed: {}", e)),
        }
    }
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

    // Same deadline as macOS (G28). PowerShell itself can wedge on a locked
    // session or a stalled GDI call, and an agent run must not stand still
    // for it either. stderr is dropped in exchange for the bound; the
    // actionable half was always the exit status.
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
        .creation_flags(0x08000000); // CREATE_NO_WINDOW
    run_capture_bounded(
        cmd,
        SCREENSHOT_TIMEOUT,
        &format!(
            "Screenshot timed out after {}s. The screen may be locked or a remote session has no display attached.",
            SCREENSHOT_TIMEOUT.as_secs()
        ),
    )
}

// macOS: the native `screencapture` CLI. `-x` = silent (no shutter sound),
// `-t png` = PNG. Needs the app to hold Screen Recording permission (TCC);
// without it screencapture exits non-zero ("could not create image from
// display") and writes nothing, so give an actionable hint instead of a
// generic failure.
#[cfg(target_os = "macos")]
fn capture_screen_to(tmp: &std::path::Path) -> Result<(), String> {
    const PERMISSION_HINT: &str = "grant LU the Screen Recording permission in System Settings ▸ Privacy & Security ▸ Screen Recording, then try again.";
    let mut cmd = std::process::Command::new("/usr/sbin/screencapture");
    cmd.args(["-x", "-t", "png"]).arg(tmp);
    // A timeout here almost always means the consent dialog is up and nobody
    // has answered it, so say that rather than blaming the capture.
    run_capture_bounded(
        cmd,
        SCREENSHOT_TIMEOUT,
        &format!(
            "Screenshot timed out after {}s, macOS is most likely waiting for a Screen Recording permission dialog. Answer it, or {}",
            SCREENSHOT_TIMEOUT.as_secs(),
            PERMISSION_HINT
        ),
    )?;
    if !tmp.exists() {
        return Err(format!("Screenshot failed, no image was written. Please {}", PERMISSION_HINT));
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

/// Which keys the previous backup carried that the incoming snapshot does not.
///
/// A key is only ever ABSENT from a snapshot when the storage read came back
/// empty, which means the store is gone, not that the user emptied it: a
/// cleared chat list still serialises to a present, valid value. So a missing
/// key is a signal that something was lost since the last backup, never a
/// deletion the user asked for.
///
/// Both sides must be JSON objects for this to mean anything. Anything else
/// answers "nothing was lost", which leaves the plain overwrite in place
/// rather than inventing a merge over data we cannot read.
pub(crate) fn keys_lost(previous: &str, incoming: &str) -> Vec<String> {
    let (Ok(serde_json::Value::Object(prev)), Ok(serde_json::Value::Object(next))) = (
        serde_json::from_str::<serde_json::Value>(previous),
        serde_json::from_str::<serde_json::Value>(incoming),
    ) else {
        return Vec::new();
    };
    prev.iter()
        .filter(|(k, v)| {
            !v.as_str().unwrap_or("").is_empty()
                && next.get(*k).and_then(|n| n.as_str()).unwrap_or("").is_empty()
        })
        .map(|(k, _)| k.clone())
        .collect()
}

/// The snapshot that actually goes to disk: the incoming one, plus every key
/// it lost carried over from the backup that is already there.
///
/// aldrich_ironhart, 2.6.5, Discord #general 18.08.: "My code chats are
/// vaporised". chat-conversations lives in IndexedDB, localStorage does not,
/// and they are different storage layers with different lifetimes. A hard
/// process kill during a self update can leave Chromium discarding the whole
/// IndexedDB database on the next start while localStorage comes back
/// untouched. On that boot the snapshot the frontend builds simply has no
/// chat-conversations in it, and this command wrote that over the one
/// remaining copy of the chats, five seconds after launch, every launch.
///
/// A backup is not a mirror. It may lag, it may hold something the live store
/// no longer has, and it must never be the thing that finishes a data loss.
pub(crate) fn merged_backup(previous: &str, incoming: &str, lost: &[String]) -> String {
    if lost.is_empty() {
        return incoming.to_string();
    }
    let (Ok(serde_json::Value::Object(prev)), Ok(serde_json::Value::Object(mut next))) = (
        serde_json::from_str::<serde_json::Value>(previous),
        serde_json::from_str::<serde_json::Value>(incoming),
    ) else {
        return incoming.to_string();
    };
    for key in lost {
        if let Some(v) = prev.get(key) {
            next.insert(key.clone(), v.clone());
        }
    }
    serde_json::Value::Object(next).to_string()
}

/// Backup all stores to %APPDATA% (survives NSIS updates). Atomic write (temp
/// file + rename) so a crash mid-write cannot truncate a previous backup.
///
/// Never destructive: a snapshot that lost a key keeps the old value for it,
/// and the untouched previous file is set aside once as store_backup.prev.json
/// so the loss can still be looked at afterwards. See merged_backup.
#[tauri::command]
pub fn backup_stores(data: String) -> Result<(), String> {
    let dir = persistent_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join("store_backup.json");
    let tmp = dir.join("store_backup.tmp");

    let previous = std::fs::read_to_string(&target).unwrap_or_default();
    let lost = keys_lost(&previous, &data);
    let payload = if lost.is_empty() {
        data
    } else {
        tracing::warn!("backup snapshot lost {:?}, keeping the previous values", lost);
        // Set the last complete file aside before it is replaced, once. The
        // merge means the next snapshot is complete again, so a machine in
        // this state writes this file on the first boot after the loss and
        // never again.
        let aside = dir.join("store_backup.prev.json");
        if !aside.exists() {
            let _ = std::fs::write(&aside, &previous);
        }
        merged_backup(&previous, &data, &lost)
    };

    std::fs::write(&tmp, &payload).map_err(|e| e.to_string())?;
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


#[cfg(test)]
mod tests {
    use super::*;

    /// aldrich_ironhart, 2.6.5, Discord #general 18.08. 12:59 "has anyone lost
    /// their chats after a restart??" and 16:12 "My code chats are vaporised".
    ///
    /// chat-conversations lives in IndexedDB and the rest of the stores live
    /// in localStorage. Those are different storage layers with different
    /// lifetimes, so a boot can come back with one gone and the other whole.
    /// On such a boot the snapshot the frontend hands this command has no
    /// chat-conversations in it at all, and the old code wrote it straight
    /// over the only remaining copy.
    #[test]
    fn a_snapshot_that_lost_the_chats_does_not_take_the_backup_with_it() {
        let previous = r#"{"__ts":"old","chat-conversations":"{\"chats\":42}","chat-settings":"{}"}"#;
        let incoming = r#"{"__ts":"new","chat-settings":"{}"}"#;

        let lost = keys_lost(previous, incoming);
        assert_eq!(lost, vec!["chat-conversations".to_string()]);

        let merged = merged_backup(previous, incoming, &lost);
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["chat-conversations"], "{\"chats\":42}");
        // The rest of the snapshot is still the new one.
        assert_eq!(v["__ts"], "new");

        // Negative control: the old rule was the incoming string, unread.
        let old_rule: serde_json::Value = serde_json::from_str(incoming).unwrap();
        assert!(old_rule.get("chat-conversations").is_none());
    }

    /// The one case that must NOT be treated as a loss. A user who deletes
    /// every chat still has a live store, so the key is present and carries a
    /// valid empty payload. Carrying the old value over there would resurrect
    /// chats somebody deliberately deleted.
    #[test]
    fn an_emptied_store_is_not_a_lost_one() {
        let previous = r#"{"chat-conversations":"{\"state\":{\"conversations\":[1,2]}}"}"#;
        let incoming = r#"{"chat-conversations":"{\"state\":{\"conversations\":[]}}"}"#;
        assert!(keys_lost(previous, incoming).is_empty());
        assert_eq!(merged_backup(previous, incoming, &[]), incoming);
    }

    #[test]
    fn a_first_backup_and_unreadable_neighbours_are_left_alone() {
        let incoming = r#"{"__ts":"new","chat-conversations":"x"}"#;
        // No previous file at all.
        assert!(keys_lost("", incoming).is_empty());
        assert_eq!(merged_backup("", incoming, &[]), incoming);
        // A previous file that is not JSON, or not an object, cannot be
        // reasoned about, and guessing over unreadable data is worse than the
        // plain overwrite this replaced.
        assert!(keys_lost("not json at all", incoming).is_empty());
        assert!(keys_lost("[1,2,3]", incoming).is_empty());
        // And an incoming payload we cannot read is written as it came.
        assert!(keys_lost(r#"{"a":"1"}"#, "not json").is_empty());
    }

    #[test]
    fn an_empty_string_value_counts_as_lost_too() {
        // The frontend skips falsy values, so this shape should not occur, but
        // an empty payload is a loss by any reading and must not overwrite.
        let previous = r#"{"chat-conversations":"real"}"#;
        let incoming = r#"{"chat-conversations":""}"#;
        assert_eq!(keys_lost(previous, incoming), vec!["chat-conversations".to_string()]);
        let merged = merged_backup(previous, incoming, &["chat-conversations".to_string()]);
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["chat-conversations"], "real");
    }

    #[test]
    fn every_key_that_went_missing_comes_back_not_just_the_first() {
        let previous = r#"{"chat-conversations":"c","locally-uncensored-memory":"m","rag-store":"r"}"#;
        let incoming = r#"{"rag-store":"r2"}"#;
        let mut lost = keys_lost(previous, incoming);
        lost.sort();
        assert_eq!(lost, vec!["chat-conversations".to_string(), "locally-uncensored-memory".to_string()]);
        let merged = merged_backup(previous, incoming, &lost);
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["chat-conversations"], "c");
        assert_eq!(v["locally-uncensored-memory"], "m");
        // A key the snapshot DID bring keeps the new value, not the old one.
        assert_eq!(v["rag-store"], "r2");
    }

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

    /// G28 (Mac, R01a 2026-08-07): the screenshot step took 138 SECONDS
    /// because macOS held `screencapture` on its consent dialog and the old
    /// code waited with `.status()`, which has no deadline at all. These use
    /// `/bin/sleep` as a stand-in for a blocked capture, because a real
    /// consent dialog cannot be summoned from a unit test.
    #[test]
    #[cfg(unix)]
    fn a_blocked_capture_is_killed_at_the_deadline() {
        let mut cmd = std::process::Command::new("/bin/sleep");
        cmd.arg("30");
        let started = std::time::Instant::now();
        let err = run_capture_bounded(
            cmd,
            std::time::Duration::from_millis(300),
            "Screenshot timed out, the consent dialog is probably up.",
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "message must say what happened: {err}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "the deadline did not fire, waited {:?}",
            started.elapsed()
        );
    }

    /// NEGATIVE CONTROL: a capture that finishes normally is untouched by the
    /// deadline and must not be reported as a failure.
    #[test]
    #[cfg(unix)]
    fn a_normal_capture_is_not_cut_short() {
        let mut ok = std::process::Command::new("/usr/bin/true");
        ok.stdout(std::process::Stdio::null());
        assert!(run_capture_bounded(ok, std::time::Duration::from_secs(5), "unused").is_ok());
    }

    /// NEGATIVE CONTROL: a real failure still reads as a failure, not as a
    /// timeout, so the permission hint is not blamed for the wrong thing.
    #[test]
    #[cfg(unix)]
    fn a_failing_capture_is_reported_as_a_failure() {
        let mut bad = std::process::Command::new("/usr/bin/false");
        bad.stdout(std::process::Stdio::null());
        let err = run_capture_bounded(bad, std::time::Duration::from_secs(5), "TIMEOUT-MARKER").unwrap_err();
        assert!(!err.contains("TIMEOUT-MARKER"), "a non-zero exit is not a timeout: {err}");
        assert!(err.contains("Screenshot failed"), "{err}");
    }

    /// The deadline shipped to users has to be generous enough for a real
    /// capture on a big display and short enough to not stall an agent run.
    #[test]
    fn the_shipped_deadline_is_sane() {
        assert!(SCREENSHOT_TIMEOUT >= std::time::Duration::from_secs(5));
        assert!(SCREENSHOT_TIMEOUT <= std::time::Duration::from_secs(60));
    }
}
