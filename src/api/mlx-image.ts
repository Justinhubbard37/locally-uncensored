/**
 * MLX-Stable-Diffusion image pipeline (Apple Silicon), running IN-PROCESS —
 * the app spawns its own MLX Python sidecar (server.py on 127.0.0.1:47712)
 * directly from Rust (`commands::mlx`), no separate lu-bridge daemon. Ported
 * from uselu/apps/web/api/mlx-image.ts; the transport is a direct Tauri
 * `invoke` via `invokeMedia` (see below) plus a readiness wait: the FastAPI
 * sidecar binds a beat after `mlx_start` returns, so a cold first generate
 * can race and 500 with "mlx unreachable".
 *
 * Hard rule: this is the Mac local image backend, NOT ComfyUI.
 */
import { backendCall, isMacOS } from './backend'
import type { ClassifiedModel } from './comfyui'

/**
 * Invoke an in-process MLX media Tauri command. The Rust wrappers
 * (`src-tauri/src/commands/media_cmds.rs`) each take a single
 * `args: serde_json::Value` parameter — matching the existing `shell_task_*`
 * convention in this codebase (see `src/api/agents/bg-tasks.ts`) — so the
 * payload must be nested under an `args` key, not passed at the top level.
 */
async function invokeMedia<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return backendCall<T>(command, { args: args ?? {} })
}

export interface MlxStatus {
  installed: boolean
  running: boolean
  port: number
  modelLoaded?: boolean
  modelRepo?: string | null
  idleSeconds?: number | null
}

/** One bridge image-catalog entry (bridge commands/mlx.rs IMAGE_CATALOG). */
export interface MlxImageModel {
  id: string
  name: string
  repo: string
  sizeGB: number
  minRamGB: number
  steps: number
  guidance: number
  defaultSize: number
  unfiltered: boolean
  description: string
  installed: boolean
}

export interface MlxInstallStatus {
  status: 'idle' | 'installing' | 'complete' | 'error'
  logs: string[]
  error: string | null
  download_progress: number
  download_total: number
  download_speed: number
}

export interface MlxGenerateArgs {
  prompt: string
  model?: string
  steps?: number
  seed?: number
  width?: number
  height?: number
  negativePrompt?: string
}

export interface MlxGenerateResult {
  image_base64: string
  width: number
  height: number
  /** Absolute path of the PNG Rust also wrote to disk. Absent only when that
   *  write failed (best-effort — a full disk must not fail a render), which
   *  costs the gallery entry its life beyond this session, nothing more. */
  output?: string
}

export async function mlxStatus(): Promise<MlxStatus> {
  return invokeMedia<MlxStatus>('mlx_status')
}

export async function mlxStart(): Promise<{ ok: boolean; port: number }> {
  return invokeMedia<{ ok: boolean; port: number }>('mlx_start')
}

export async function mlxUnload(): Promise<{ ok: boolean; was_loaded: boolean; running: boolean }> {
  return invokeMedia('mlx_unload')
}

export async function mlxGenerate(args: MlxGenerateArgs): Promise<MlxGenerateResult> {
  const body: Record<string, unknown> = { prompt: args.prompt }
  if (args.model) body.model = args.model
  if (args.steps != null) body.steps = args.steps
  if (args.seed != null && args.seed !== -1) body.seed = args.seed
  if (args.width != null) body.width = args.width
  if (args.height != null) body.height = args.height
  if (args.negativePrompt) body.negative_prompt = args.negativePrompt
  // A single long-blocking request (model load + diffusion) — in-process
  // invoke has no per-call timeout to pass (unlike the old HTTP bridgeCmd).
  return invokeMedia<MlxGenerateResult>('mlx_generate', body)
}

export async function listMlxImageModels(): Promise<MlxImageModel[]> {
  return invokeMedia<MlxImageModel[]>('mlx_image_models')
}

export async function installMlxImageModel(
  id: string,
): Promise<{ ok: boolean; status: string; id?: string }> {
  return invokeMedia('mlx_image_install_model', { id })
}

export async function getMlxImageInstallStatus(): Promise<MlxInstallStatus> {
  return invokeMedia<MlxInstallStatus>('mlx_image_install_status')
}

export async function deleteMlxImageModel(id: string): Promise<{ ok: boolean; id: string }> {
  return invokeMedia('mlx_image_delete_model', { id })
}

/** Install the MLX image engine itself (venv + torch/diffusers sidecar). */
export async function installMlxImageEngine(): Promise<{ ok: boolean; status: string }> {
  return invokeMedia('install_mlx_diffusion')
}

export async function getMlxImageEngineStatus(): Promise<MlxInstallStatus> {
  return invokeMedia<MlxInstallStatus>('install_mlx_diffusion_status')
}

export type MlxImageDecision = 'use' | 'start' | 'comfyui' | 'unavailable'

export function decideMlxImageBackend(opts: {
  isAppleSilicon: boolean
  comfyHasModels: boolean
  mlx: MlxStatus | null
}): MlxImageDecision {
  if (opts.comfyHasModels) return 'comfyui'
  if (!opts.isAppleSilicon) return 'comfyui'
  if (!opts.mlx || !opts.mlx.installed) return 'unavailable'
  return opts.mlx.running ? 'use' : 'start'
}

/** Poll `mlx_status` until the sidecar reports `running`, or time out. */
async function waitForMlxRunning(timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if ((await mlxStatus().catch(() => null))?.running) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

/**
 * Ensure the MLX sidecar is up and warm, then generate and return a
 * ready-to-render PNG data URL. Throws on any failure so callers surface a
 * single error string. Retries once on a transient "unreachable" — the cold
 * sidecar binds its port a moment after `mlx_start` returns.
 */
export async function generateMlxImageDataUrl(
  args: MlxGenerateArgs,
): Promise<{ dataUrl: string; width: number; height: number; localPath?: string }> {
  const status = await mlxStatus()
  if (!status.installed) {
    throw new Error(
      'The local image engine is not set up on this Mac yet (a one-time setup of the on-device image models is needed before local generation works).',
    )
  }
  if (!status.running) {
    await mlxStart()
    await waitForMlxRunning()
  }
  let result: MlxGenerateResult
  try {
    result = await mlxGenerate(args)
  } catch (e) {
    // Cold-start race: the sidecar port bound a beat late. Wait + retry once.
    if (/unreachable|refused|reset|ECONNREFUSED/i.test(String(e))) {
      await waitForMlxRunning()
      result = await mlxGenerate(args)
    } else {
      throw e
    }
  }
  return {
    dataUrl: `data:image/png;base64,${result.image_base64}`,
    width: result.width,
    height: result.height,
    localPath: result.output,
  }
}

/** True when this machine is a Mac (Apple Silicon build → the MLX host). */
export function isMlxImageHost(): boolean {
  return isMacOS()
}

export const MLX_MODEL_PREFIX = 'MLX '
export const MLX_IMAGE_MODEL_NAME = 'MLX SD-Turbo'

export function mlxDisplayName(m: Pick<MlxImageModel, 'name'>): string {
  return `${MLX_MODEL_PREFIX}${m.name}`
}

const mlxIdByDisplayName = new Map<string, string>([[MLX_IMAGE_MODEL_NAME, 'sd-turbo']])

/** Resolve a dropdown selection back to the bridge catalog id. */
export function mlxModelIdFor(displayName: string | null | undefined): string {
  return (displayName && mlxIdByDisplayName.get(displayName)) || 'sd-turbo'
}

export function mlxModelType(m: Pick<MlxImageModel, 'id' | 'defaultSize'>): ClassifiedModel['type'] {
  if (m.id === 'z-image-turbo') return 'zimage'
  return m.defaultSize >= 1024 ? 'sdxl' : 'sd15'
}

export function buildMlxImageModels(catalog: MlxImageModel[]): ClassifiedModel[] {
  return catalog
    .filter((m) => m.installed)
    .map((m) => {
      mlxIdByDisplayName.set(mlxDisplayName(m), m.id)
      return { name: mlxDisplayName(m), type: mlxModelType(m), source: 'checkpoint' } satisfies ClassifiedModel
    })
}

/** True when the given model name is a synthetic MLX image model. */
export function isMlxImageModel(name: string | null | undefined): boolean {
  return !!name && name.startsWith(MLX_MODEL_PREFIX)
}

/** Merge synthetic MLX models into ComfyUI image models — MLX first, dedup by name. */
export function mergeImageModels(
  comfy: ClassifiedModel[],
  mlx: ClassifiedModel[],
): ClassifiedModel[] {
  const names = new Set(mlx.map((m) => m.name))
  return [...mlx, ...comfy.filter((m) => !names.has(m.name))]
}
