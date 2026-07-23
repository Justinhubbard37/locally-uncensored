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

    pub fn set_download(&self, progress: u64, total: u64) {
        let mut g = self.inner.lock().unwrap();
        g.download_progress = progress;
        g.download_total = total;
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
