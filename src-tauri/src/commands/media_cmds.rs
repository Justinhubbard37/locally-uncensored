//! Tauri command wrappers for the in-process MLX media engine (image + video).
//!
//! Thin pass-through to `commands::mlx` / `commands::video`, which were
//! ported verbatim from `uselu/apps/bridge` (an axum HTTP daemon) and take a
//! single `args: serde_json::Value` blob per call instead of individually
//! named parameters. That matches the existing `shell_task_*` convention in
//! this codebase (see `bg_tasks.rs`'s "Tauri-callable wrappers" section) —
//! every wrapper below takes exactly one `args: Value` parameter, and the
//! frontend MUST invoke with the payload nested as `{ args: {...} }` (see
//! `src/api/agents/bg-tasks.ts` for the precedent and its "missing required
//! key args" warning). `src/api/mlx-image.ts` / `src/api/mlx-video.ts` do
//! this via a small `invokeMedia` helper.
//!
//! No separate lu-bridge daemon: the app spawns its own MLX Python sidecar
//! (server.py on 127.0.0.1:47712) directly from `commands::mlx`, exactly
//! like the existing ComfyUI/whisper sidecars.

use crate::os_error;
use crate::state::AppState;
use base64::Engine;
use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

// ── MLX image (MLX-Stable-Diffusion) ────────────────────────────────────

#[tauri::command]
pub async fn mlx_status(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::mlx_status(state.inner(), &args).await
}

#[tauri::command]
pub fn mlx_start(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::mlx_start(state.inner(), &args)
}

#[tauri::command]
pub async fn mlx_unload(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::mlx_unload(state.inner(), &args).await
}

#[tauri::command]
pub async fn mlx_generate(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::mlx_generate(state.inner(), &args).await
}

#[tauri::command]
pub fn mlx_image_models(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::mlx_image_models(state.inner(), &args)
}

#[tauri::command]
pub fn set_hf_token(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::set_hf_token(state.inner(), &args)
}

#[tauri::command]
pub fn hf_token_present(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::hf_token_present(state.inner(), &args)
}

#[tauri::command]
pub fn mlx_image_install_model(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::mlx_image_install_model(state.inner(), &args)
}

#[tauri::command]
pub fn mlx_image_install_status(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::mlx_image_install_status(state.inner(), &args)
}

#[tauri::command]
pub fn mlx_image_delete_model(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::mlx_image_delete_model(state.inner(), &args)
}

#[tauri::command]
pub fn install_mlx_diffusion(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::install_mlx_diffusion(state.inner(), &args)
}

#[tauri::command]
pub fn install_mlx_diffusion_status(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::install_mlx_diffusion_status(state.inner(), &args)
}

// ── MLX video ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn video_status(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::video::video_status(state.inner(), &args)
}

#[tauri::command]
pub fn video_list_models(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::video::video_list_models(state.inner(), &args)
}

#[tauri::command]
pub fn video_install_mlx(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::video::video_install_mlx(state.inner(), &args)
}

#[tauri::command]
pub fn video_install_mlx_status(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::video::video_install_mlx_status(state.inner(), &args)
}

#[tauri::command]
pub fn video_install_model(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::video::video_install_model(state.inner(), &args)
}

#[tauri::command]
pub fn video_install_model_status(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::video::video_install_model_status(state.inner(), &args)
}

#[tauri::command]
pub fn video_delete_model(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::video::video_delete_model(state.inner(), &args)
}

#[tauri::command]
pub fn video_generate(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::video::video_generate(state.inner(), &args)
}

#[tauri::command]
pub fn video_progress(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::video::video_progress(state.inner(), &args)
}

#[tauri::command]
pub fn video_cancel(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::video::video_cancel(state.inner(), &args)
}

// ── Media playback (video → blob URL) ───────────────────────────────────
//
// MLX video never touches the sidecar HTTP surface the image path uses
// (`mlx_generate` proxies to :47712 and returns base64 straight from the
// response body) — `video_generate` runs `mlx_video.*.generate` as a bare
// subprocess and writes an mp4 to disk (`commands::video::outputs_root()`).
// With the lu-bridge daemon gone there is nothing serving that file at
// :47711/videos/<file> anymore, and the CSP's `media-src` has no `file:`
// grant (only `'self' blob: http://localhost:* http://127.0.0.1:*`), so a
// `<video src="file:///...">` would just be blocked. Read the bytes here
// and let the frontend build a `blob:` URL instead — that's an origin the
// CSP already allows.

/// Roots `read_media_file` is allowed to serve bytes from. Only MLX video
/// output today (MLX images are never written to disk — see above); add
/// more roots here if a future in-process media backend gains one.
fn allowed_media_roots() -> Vec<PathBuf> {
    vec![
        crate::commands::video::outputs_root(),
        // Stills from the MLX image lane. They land on disk so the gallery
        // survives a restart — the in-memory data URL does not (createStore's
        // partialize strips it), and without a file there was nothing left to
        // re-read.
        crate::commands::mlx::images_root(),
    ]
}

/// Read a file from one of the app's own media output directories and
/// return its bytes as base64, so the frontend can turn it into a
/// `Blob`/`URL.createObjectURL` blob: URL for `<video>` playback and
/// Download.
///
/// Path-traversal guard: canonicalizes both `path` and every allowed root
/// (resolving `..` and symlinks) and rejects anything whose canonical form
/// doesn't fall under an allowed root — this is NOT a general-purpose file
/// read, it only ever serves the app's own generated media.
#[tauri::command]
pub fn read_media_file(path: String) -> Result<String, String> {
    let candidate = PathBuf::from(&path);
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("read_media_file: {}: {e}", candidate.display()))?;

    let allowed = allowed_media_roots().into_iter().any(|root| {
        root.canonicalize()
            .map(|r| canonical.starts_with(&r))
            .unwrap_or(false)
    });
    if !allowed {
        return Err(format!(
            "read_media_file: path escapes the allowed media directories: {}",
            canonical.display()
        ));
    }

    let bytes = std::fs::read(&canonical)
        .map_err(|e| format!("read_media_file: {}: {}", canonical.display(), os_error::english(&e)))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
