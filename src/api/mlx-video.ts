/**
 * MLX-video pipeline (Apple Silicon), via the bundled lu-bridge sidecar.
 * Ported from uselu/apps/web/api/video.ts — transport swapped to `bridgeCmd`
 * (127.0.0.1:47711/cmd/*). The bridge spawns `python -m mlx_video.<family>.
 * generate` as a subprocess and exposes progress the frontend polls.
 *
 * Hard rule: this is the Mac local video backend, NOT ComfyUI. Only Apple
 * Silicon Macs see a real surface — every call returns `available:false`
 * elsewhere so the UI can dim/skip it.
 */
import { bridgeCmd } from './bridge-client'

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
  return bridgeCmd<VideoStatus>('video_status')
}

export async function listVideoModels(): Promise<VideoModel[]> {
  return bridgeCmd<VideoModel[]>('video_list_models')
}

export async function installMlxVideo(): Promise<{ ok: boolean; status: string }> {
  return bridgeCmd<{ ok: boolean; status: string }>('video_install_mlx', {}, 1_800_000)
}

export async function getMlxInstallStatus(): Promise<InstallStatus> {
  return bridgeCmd<InstallStatus>('video_install_mlx_status')
}

export async function installVideoModel(
  id: string,
): Promise<{ ok: boolean; status: string; id?: string }> {
  return bridgeCmd('video_install_model', { id })
}

export async function getModelInstallStatus(): Promise<InstallStatus> {
  return bridgeCmd<InstallStatus>('video_install_model_status')
}

export async function deleteVideoModel(id: string): Promise<{ ok: boolean; id: string }> {
  return bridgeCmd('video_delete_model', { id })
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
  return bridgeCmd<GenerateResult>('video_generate', body, 120_000)
}

export async function getVideoProgress(): Promise<VideoProgress> {
  return bridgeCmd<VideoProgress>('video_progress')
}

export async function cancelVideo(): Promise<{ ok: boolean }> {
  return bridgeCmd<{ ok: boolean }>('video_cancel')
}

/** Bridge base for <video src> playback of a finished clip (served at /videos/:file). */
export const MLX_VIDEO_BASE = 'http://127.0.0.1:47711'
