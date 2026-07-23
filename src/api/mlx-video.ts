/**
 * MLX-video pipeline (Apple Silicon), running IN-PROCESS — Rust
 * (`commands::video`) spawns `python -m mlx_video.<family>.generate` as a
 * subprocess directly, no separate lu-bridge daemon. Ported from
 * uselu/apps/web/api/video.ts; the transport is a direct Tauri `invoke` via
 * `invokeMedia` (see mlx-image.ts) and progress is exposed for the frontend
 * to poll.
 *
 * Hard rule: this is the Mac local video backend, NOT ComfyUI. Only Apple
 * Silicon Macs see a real surface — every call returns `available:false`
 * elsewhere so the UI can dim/skip it.
 */
import { backendCall } from './backend'

/** See the `invokeMedia` doc comment in `mlx-image.ts` — the Rust wrappers
 *  take a single `args: serde_json::Value` param, so the payload must be
 *  nested under an `args` key. */
async function invokeMedia<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return backendCall<T>(command, { args: args ?? {} })
}

export interface VideoStatus {
  available: boolean
  appleSilicon: boolean
  mlxInstalled: boolean
  mlxVersion: string | null
  pythonBin: string | null
  modelsRoot: string
  outputsRoot: string
  installedModels: string[]
  running: boolean
}

export interface VideoModel {
  id: string
  name: string
  family: 'wan_2' | 'ltx_2' | string
  repo: string
  sizeGB: number
  minRamGB: number
  defaultFrames: number
  needsConvert: boolean
  unfiltered: boolean
  description: string
  installed: boolean
}

export interface VideoProgress {
  running: boolean
  status: 'idle' | 'installing' | 'complete' | 'error' | string
  logs: string[]
  error: string | null
}

export interface InstallStatus {
  status: 'idle' | 'installing' | 'complete' | 'error'
  logs: string[]
  download_progress: number
  download_total: number
  download_speed: number
  error: string | null
}

export interface GenerateParams {
  id: string
  prompt: string
  seconds?: number
  fps?: number
  initImage?: string
  seed?: number
}

export interface GenerateResult {
  ok: boolean
  jobId: string
  pid: number
  output: string
}

export async function getVideoStatus(): Promise<VideoStatus> {
  return invokeMedia<VideoStatus>('video_status')
}

export async function listVideoModels(): Promise<VideoModel[]> {
  return invokeMedia<VideoModel[]>('video_list_models')
}

export async function installMlxVideo(): Promise<{ ok: boolean; status: string }> {
  return invokeMedia<{ ok: boolean; status: string }>('video_install_mlx')
}

export async function getMlxInstallStatus(): Promise<InstallStatus> {
  return invokeMedia<InstallStatus>('video_install_mlx_status')
}

export async function installVideoModel(
  id: string,
): Promise<{ ok: boolean; status: string; id?: string }> {
  return invokeMedia('video_install_model', { id })
}

export async function getModelInstallStatus(): Promise<InstallStatus> {
  return invokeMedia<InstallStatus>('video_install_model_status')
}

export async function deleteVideoModel(id: string): Promise<{ ok: boolean; id: string }> {
  return invokeMedia('video_delete_model', { id })
}

export async function generateVideo(params: GenerateParams): Promise<GenerateResult> {
  const body = {
    id: params.id,
    prompt: params.prompt,
    seconds: params.seconds,
    fps: params.fps,
    init_image: params.initImage,
    seed: params.seed,
  }
  // Kick off the subprocess; generation itself is polled via video_progress.
  return invokeMedia<GenerateResult>('video_generate', body)
}

export async function getVideoProgress(): Promise<VideoProgress> {
  return invokeMedia<VideoProgress>('video_progress')
}

export async function cancelVideo(): Promise<{ ok: boolean }> {
  return invokeMedia<{ ok: boolean }>('video_cancel')
}
