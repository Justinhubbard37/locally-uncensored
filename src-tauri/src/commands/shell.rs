use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use std::path::{Path, PathBuf};

/// Resolve the per-chat agent workspace (`~/agent-workspace/<chat_id>/`).
/// Mirrors commands/filesystem.rs::resolve_path so shell output lands in the
/// SAME folder the file tools write to. Used as the fallback cwd when the
/// caller doesn't pass one — without it the child process inherits the LU
/// app's ambient cwd and dumps build output into ~/Documents (David 2026-06-04).
fn workspace_cwd(chat_id: Option<&str>) -> PathBuf {
    let id = chat_id.unwrap_or("default");
    let safe: String = id
        .chars()
        .take(64)
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' { c } else { '_' })
        .collect();
    let slug = if safe.is_empty() { "default".to_string() } else { safe };
    dirs::home_dir()
        .unwrap_or_default()
        .join("agent-workspace")
        .join(slug)
}

/// How much of a command's output travels back to the model. Anything past this
/// is still read off the pipe — it has to be, or the child blocks — but dropped.
const MAX_CAPTURE: usize = 256 * 1024;

#[derive(Default)]
struct Captured {
    kept: Vec<u8>,
    total: usize,
}

/// Drain a child pipe on its own thread. The pipe MUST be read while the process
/// runs: an OS pipe buffer is only tens of kilobytes, and a child that fills it
/// blocks on write forever. Reading only after `try_wait()` reports an exit
/// therefore deadlocks on any command with real output — it hit the full timeout
/// and returned nothing at all.
fn drain(mut pipe: impl Read + Send + 'static) -> (Arc<Mutex<Captured>>, Arc<AtomicBool>) {
    let buf = Arc::new(Mutex::new(Captured::default()));
    let done = Arc::new(AtomicBool::new(false));
    let sink = Arc::clone(&buf);
    let flag = Arc::clone(&done);
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut c) = sink.lock() {
                        c.total += n;
                        let room = MAX_CAPTURE.saturating_sub(c.kept.len());
                        if room > 0 {
                            c.kept.extend_from_slice(&chunk[..n.min(room)]);
                        }
                    }
                }
            }
        }
        flag.store(true, Ordering::Release);
    });
    (buf, done)
}

/// Decode captured bytes leniently. Build tools on a non-UTF-8 Windows codepage
/// emit bytes `read_to_string` rejects outright — that used to throw the whole
/// output away and hand the model an empty string next to a successful exit code.
fn captured_text(buf: &Arc<Mutex<Captured>>) -> String {
    let c = match buf.lock() {
        Ok(c) => c,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut text = String::from_utf8_lossy(&c.kept).into_owned();
    if c.total > c.kept.len() {
        text.push_str(&format!(
            "\n[output truncated: {} of {} bytes shown]",
            c.kept.len(),
            c.total
        ));
    }
    text
}

/// Give the reader threads a moment to hit EOF after the child is gone. Never
/// joins them: a grandchild can keep the pipe open (a spawned dev server), and
/// joining would hang the command instead of returning what we already have.
fn settle(a: &Arc<AtomicBool>, b: &Arc<AtomicBool>, max: std::time::Duration) {
    let deadline = std::time::Instant::now() + max;
    while std::time::Instant::now() < deadline {
        if a.load(Ordering::Acquire) && b.load(Ordering::Acquire) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn shell_execute(
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    timeout: Option<u64>,
    shell: Option<String>,
    chatId: Option<String>,
    workingDirectory: Option<String>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        shell_execute_sync(command, args, cwd, timeout, shell, chatId, workingDirectory)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

fn shell_execute_sync(
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    timeout: Option<u64>,
    shell: Option<String>,
    chat_id: Option<String>,
    working_directory: Option<String>,
) -> Result<serde_json::Value, String> {
    let timeout_ms = timeout.unwrap_or(120_000);
    let shell_bin = shell.unwrap_or_else(|| {
        if cfg!(target_os = "windows") {
            "powershell".to_string()
        } else {
            "bash".to_string()
        }
    });

    let mut cmd = Command::new(&shell_bin);

    // Build shell command
    if cfg!(target_os = "windows") && shell_bin.to_lowercase().contains("powershell") {
        cmd.arg("-NoProfile").arg("-NonInteractive").arg("-Command").arg(&command);
    } else if cfg!(target_os = "windows") && shell_bin.to_lowercase().contains("cmd") {
        cmd.arg("/C").arg(&command);
    } else {
        cmd.arg("-c").arg(&command);
    }

    // Append extra args
    if let Some(extra_args) = args {
        for a in extra_args {
            cmd.arg(&a);
        }
    }

    // Working directory. Use the explicit cwd when it exists; otherwise fall
    // back to the per-chat agent workspace (created if missing) so a relative
    // command never runs in the app's ambient cwd and scatters files into
    // ~/Documents (David 2026-06-04). Mirrors the file tools' path resolution.
    let workdir: PathBuf = match cwd.as_ref().map(|d| Path::new(d)) {
        Some(p) if p.is_dir() => p.to_path_buf(),
        _ => match working_directory.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            // Folder workspace (the user's repo, from chatCtx.workingDirectory)
            // wins over the per-chat sandbox for relative commands (#62).
            Some(wd) => PathBuf::from(wd),
            None => {
                let w = workspace_cwd(chat_id.as_deref());
                let _ = std::fs::create_dir_all(&w);
                w
            }
        },
    };
    if workdir.is_dir() {
        cmd.current_dir(&workdir);
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("Spawn shell: {}", e))?;

    // Start draining both pipes immediately — see `drain`.
    let (out_buf, out_done) = match child.stdout.take() {
        Some(p) => drain(p),
        None => (Arc::new(Mutex::new(Captured::default())), Arc::new(AtomicBool::new(true))),
    };
    let (err_buf, err_done) = match child.stderr.take() {
        Some(p) => drain(p),
        None => (Arc::new(Mutex::new(Captured::default())), Arc::new(AtomicBool::new(true))),
    };

    let start = std::time::Instant::now();
    let timeout_dur = std::time::Duration::from_millis(timeout_ms);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                settle(&out_done, &err_done, std::time::Duration::from_millis(500));
                return Ok(serde_json::json!({
                    "stdout": captured_text(&out_buf),
                    "stderr": captured_text(&err_buf),
                    "exitCode": status.code().unwrap_or(-1),
                    "timedOut": false,
                }));
            }
            Ok(None) => {
                if start.elapsed() > timeout_dur {
                    let _ = child.kill();
                    settle(&out_done, &err_done, std::time::Duration::from_millis(200));
                    // Hand back whatever the command managed to print. A build
                    // that dies on the timeout still tells the model where it got.
                    let mut stderr_str = captured_text(&err_buf);
                    if !stderr_str.is_empty() {
                        stderr_str.push('\n');
                    }
                    stderr_str.push_str(&format!("Execution timed out after {}ms", timeout_ms));
                    return Ok(serde_json::json!({
                        "stdout": captured_text(&out_buf),
                        "stderr": stderr_str,
                        "exitCode": -1,
                        "timedOut": true,
                    }));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Wait error: {}", e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn capture(bytes: Vec<u8>) -> String {
        let (buf, done) = drain(Cursor::new(bytes));
        settle(&done, &done, std::time::Duration::from_secs(2));
        captured_text(&buf)
    }

    #[test]
    fn output_survives_bytes_that_are_not_utf8() {
        // "Grüße" in CP1252 — what a Windows build tool prints. read_to_string
        // used to reject this and leave the model with an empty result.
        let text = capture(vec![b'G', b'r', 0xfc, 0xdf, b'e']);
        assert!(text.starts_with("Gr"), "lost the output: {:?}", text);
        assert!(text.ends_with('e'), "lost the tail: {:?}", text);
    }

    #[test]
    fn oversized_output_is_capped_and_says_so() {
        let text = capture(vec![b'x'; MAX_CAPTURE + 5_000]);
        assert!(text.contains("output truncated"), "no truncation note: {:?}", &text[..64]);
        assert!(text.len() < MAX_CAPTURE + 200);
    }

    #[test]
    fn small_output_comes_back_whole_and_unannotated() {
        let text = capture(b"hello\n".to_vec());
        assert_eq!(text, "hello\n");
    }
}
