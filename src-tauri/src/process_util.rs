//! Process spawning + lifecycle helpers used by ComfyUI / LM Studio / Claude
//! Code lifecycle commands.
//!
//! On Windows we use Job Objects (KILL_ON_JOB_CLOSE) so any child process tree
//! gets cleaned up when the bridge exits, and prefer `taskkill /T /F` for
//! recursive kills. On Unix we use a process-group kill via `kill -- -PGID` so
//! Python subprocess trees don't leak.

use std::process::{Child, Command, Stdio};

#[cfg(windows)]
pub fn no_window() -> u32 {
    0x08000000 // CREATE_NO_WINDOW
}

/// Suppress the console window for a std `Command` on Windows (CREATE_NO_WINDOW);
/// no-op elsewhere. Use for every CLI we shell out to (lms, git, python probes)
/// so users don't get console flashes.
pub fn suppress_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(no_window());
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Spawn a command with stdout+stderr piped, console suppressed on Windows.
pub fn spawn_piped(mut cmd: Command) -> std::io::Result<Child> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(no_window());
    }
    #[cfg(unix)]
    {
        // Create our own process group so we can kill the whole tree later.
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc_setpgid_self() != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd.spawn()
}

/// Recursive process-tree kill. On Windows uses `taskkill /T /F /PID`; on
/// Unix sends SIGTERM to the process group then SIGKILL after a grace.
pub fn kill_tree(child: &mut Child) -> std::io::Result<()> {
    let pid = child.id();
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        unsafe {
            // Negative PID kills the process group.
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        std::thread::sleep(std::time::Duration::from_millis(800));
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

/// Best-effort stop of whatever process is LISTENING on a local TCP port.
/// Used by the "Stop" buttons for port-bound backends the bridge didn't spawn
/// itself (so there's no `Child` handle to kill) — the MLX sidecar and the
/// Ollama server. Only the listener is targeted (`-sTCP:LISTEN`), so the
/// bridge's own client connections to that port aren't hit.
pub fn kill_listeners_on_port(port: u16) {
    #[cfg(unix)]
    {
        if let Ok(out) = Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
            .stderr(Stdio::null())
            .output()
        {
            for pid in String::from_utf8_lossy(&out.stdout)
                .split_whitespace()
                .filter_map(|s| s.parse::<i32>().ok())
            {
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if let Ok(out) = Command::new("cmd")
            .args(["/C", &format!("netstat -ano -p tcp | findstr LISTENING | findstr :{port}")])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Some(pid) = line.split_whitespace().last() {
                    let _ = Command::new("taskkill")
                        .args(["/F", "/PID", pid])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
            }
        }
    }
}

#[cfg(unix)]
extern "C" {
    fn setpgid(pid: libc::pid_t, pgid: libc::pid_t) -> libc::c_int;
}

#[cfg(unix)]
fn libc_setpgid_self() -> libc::c_int {
    unsafe { setpgid(0, 0) }
}

// Minimal libc binding so we can avoid an extra crate.
#[cfg(unix)]
#[allow(non_camel_case_types)]
mod libc {
    pub type pid_t = i32;
    pub type c_int = i32;
    pub const SIGTERM: c_int = 15;
    pub const SIGKILL: c_int = 9;
    extern "C" {
        pub fn kill(pid: pid_t, sig: c_int) -> c_int;
    }
}
