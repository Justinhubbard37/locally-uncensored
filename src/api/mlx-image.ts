/**
 * MLX-Stable-Diffusion image pipeline (Apple Silicon), via the bundled
 * lu-bridge sidecar. Ported from uselu/apps/web/api/mlx-image.ts — the only
 * change is the transport (`bridgeCmd` → 127.0.0.1:47711/cmd/*) plus a
 * readiness wait: the FastAPI sidecar (:47712) binds a beat after `mlx_start`
 * returns, so a cold first generate can race and 500 with "mlx unreachable".
 *
 * Hard rule: this is the Mac local image backend, NOT ComfyUI.
 */
import { bridgeCmd } from './bridge-client'
import { isMacOS } from './backend'
import type { ClassifiedModel } from './comfyui'

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
}

export async function mlxStatus(): Promise<MlxStatus> {
  return bridgeCmd<MlxStatus>('mlx_status')
}

export async function mlxStart(): Promise<{ ok: boolean; port: number }> {
  return bridgeCmd<{ ok: boolean; port: number }>('mlx_start')
}

export async function mlxUnload(): Promise<{ ok: boolean; was_loaded: boolean; running: boolean }> {
  return bridgeCmd('mlx_unload')
}

export async function mlxGenerate(args: MlxGenerateArgs): Promise<MlxGenerateResult> {
  const body: Record<string, unknown> = { prompt: args.prompt }
  if (args.model) body.model = args.model
  if (args.steps != null) body.steps = args.steps
  if (args.seed != null && args.seed !== -1) body.seed = args.seed
  if (args.width != null) body.width = args.width
  if (args.height != null) body.height = args.height
  if (args.negativePrompt) body.negative_prompt = args.negativePrompt
  // A single long-blocking request (model load + diffusion) — allow 5 min.
  return bridgeCmd<MlxGenerateResult>('mlx_generate', body, 300_000)
}

export async function listMlxImageModels(): Promise<MlxImageModel[]> {
  return bridgeCmd<MlxImageModel[]>('mlx_image_models')
}

export async function installMlxImageModel(
  id: string,
): Promise<{ ok: boolean; status: string; id?: string }> {
  return bridgeCmd('mlx_image_install_model', { id })
}

export async function getMlxImageInstallStatus(): Promise<MlxInstallStatus> {
  return bridgeCmd<MlxInstallStatus>('mlx_image_install_status')
}

export async function deleteMlxImageModel(id: string): Promise<{ ok: boolean; id: string }> {
  return bridgeCmd('mlx_image_delete_model', { id })
}

/** Install the MLX image engine itself (venv + torch/diffusers sidecar). */
export async function installMlxImageEngine(): Promise<{ ok: boolean; status: string }> {
  return bridgeCmd('install_mlx_diffusion', {}, 1_800_000)
}

export async function getMlxImageEngineStatus(): Promise<MlxInstallStatus> {
  return bridgeCmd<MlxInstallStatus>('install_mlx_diffusion_status')
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
): Promise<{ dataUrl: string; width: number; height: number }> {
  const status = await mlxStatus()
  if (!status.installed) {
    throw new Error(
      'MLX image generation is not installed. Open Models → Discover → Mac Image to install it.',
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
