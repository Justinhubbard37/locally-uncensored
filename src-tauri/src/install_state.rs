//! Shared install-progress state. Each long-running installer (Python, ComfyUI,
//! LM Studio, Claude Code, SearXNG) owns one of these and the frontend polls
//! `install_*_status` to render progress + logs.

use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
pub struct InstallProgress {
    pub status: String,
    pub logs: Vec<String>,
    pub download_progress: u64,
    pub download_total: u64,
    pub download_speed: u64,
    pub error: Option<String>,
}

impl Default for InstallProgress {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            logs: Vec::new(),
            download_progress: 0,
            download_total: 0,
            download_speed: 0,
            error: None,
        }
    }
}

#[derive(Clone, Default)]
pub struct InstallSlot {
    inner: Arc<Mutex<InstallProgress>>,
}

impl InstallSlot {
    pub fn snapshot(&self) -> InstallProgress {
        self.inner.lock().unwrap().clone()
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().unwrap().status == "installing"
    }

    pub fn start(&self) {
        let mut g = self.inner.lock().unwrap();
        *g = InstallProgress {
            status: "installing".into(),
            ..Default::default()
        };
    }

    pub fn log(&self, line: impl Into<String>) {
        let mut g = self.inner.lock().unwrap();
        let entry = line.into();
        tracing::info!("[install] {entry}");
        g.logs.push(entry);
        if g.logs.len() > 200 {
            let drop = g.logs.len() - 200;
            g.logs.drain(..drop);
        }
    }

    pub fn set_download(&self, progress: u64, total: u64, speed: u64) {
        let mut g = self.inner.lock().unwrap();
        g.download_progress = if total > 0 { progress.min(total) } else { progress };
        g.download_total = total;
        g.download_speed = speed;
    }

    pub fn complete(&self, msg: impl Into<String>) {
        let mut g = self.inner.lock().unwrap();
        g.status = "complete".into();
        g.logs.push(msg.into());
    }

    pub fn fail(&self, msg: impl Into<String>) {
        let mut g = self.inner.lock().unwrap();
        let m = msg.into();
        tracing::error!("[install] failed: {m}");
        g.status = "error".into();
        g.error = Some(m.clone());
        g.logs.push(format!("ERROR: {m}"));
    }
}

fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(read) = std::fs::read_dir(path) else {
        return 0;
    };
    read.flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

/// Feed a slot's byte progress from the size of the directory the download
/// writes into, until the slot leaves "installing". The installers shell out
/// to `huggingface_hub.snapshot_download`, which reports nothing machine-
/// readable on stdout; the growing target directory is the one progress
/// signal that exists on every platform.
pub fn watch_dir_size(slot: InstallSlot, dir: std::path::PathBuf, total_bytes: u64) {
    std::thread::spawn(move || {
        let mut last: Option<(std::time::Instant, u64)> = None;
        while slot.is_running() {
            let size = dir_size(&dir);
            let speed = match last {
                Some((t, prev)) if size > prev => {
                    ((size - prev) as f64 / t.elapsed().as_secs_f64().max(0.001)) as u64
                }
                _ => 0,
            };
            last = Some((std::time::Instant::now(), size));
            slot.set_download(size, total_bytes, speed);
            std::thread::sleep(std::time::Duration::from_millis(1000));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_download_clamps_to_total_and_keeps_speed() {
        let slot = InstallSlot::default();
        slot.start();
        slot.set_download(500, 1000, 42);
        let s = slot.snapshot();
        assert_eq!((s.download_progress, s.download_total, s.download_speed), (500, 1000, 42));
        // A convert step growing the dir past the download size must not
        // report more than 100%.
        slot.set_download(1500, 1000, 7);
        assert_eq!(slot.snapshot().download_progress, 1000);
        // No known total: pass the raw byte count through.
        slot.set_download(1500, 0, 0);
        assert_eq!(slot.snapshot().download_progress, 1500);
    }

    #[test]
    fn dir_size_sums_nested_files() {
        let root = std::env::temp_dir().join(format!("lu-dirsize-{}", std::process::id()));
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(root.join("a.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(sub.join("b.bin"), vec![0u8; 50]).unwrap();
        assert_eq!(dir_size(&root), 150);
        std::fs::remove_dir_all(&root).unwrap();
        // A directory that does not exist yet reads as empty, not an error;
        // the watcher starts before snapshot_download creates the target.
        assert_eq!(dir_size(&root), 0);
    }
}
