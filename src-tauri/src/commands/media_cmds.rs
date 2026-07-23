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

use crate::state::AppState;
use serde_json::Value;
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
