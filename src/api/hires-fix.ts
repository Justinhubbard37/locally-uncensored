export type HiresUpscaleMethod =
  | 'nearest-exact'
  | 'bilinear'
  | 'area'
  | 'bicubic'
  | 'bislerp'

export interface NativeHiresFixOptions {
  baseWidth: number
  baseHeight: number
  scale: number
  denoise: number
  steps: number
  upscaleMethod: HiresUpscaleMethod
}

export interface NativeHiresFixResult {
  workflow: Record<string, any>
  width: number
  height: number
  upscaleNodeId: string
  samplerNodeId: string
}

export class NativeHiresFixError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeHiresFixError'
  }
}

const IMAGE_OUTPUT_NODES = new Set(['SaveImage', 'PreviewImage'])
const IMAGE_DECODE_NODES = new Set(['VAEDecode', 'VAEDecodeTiled'])
const UPSCALE_METHODS: ReadonlySet<HiresUpscaleMethod> = new Set([
  'nearest-exact',
  'bilinear',
  'area',
  'bicubic',
  'bislerp',
])

function isNodeRef(value: unknown): value is [string, number] {
  return Array.isArray(value)
    && value.length >= 2
    && (typeof value[0] === 'string' || typeof value[0] === 'number')
    && typeof value[1] === 'number'
}

function cloneWorkflow(workflow: Record<string, any>): Record<string, any> {
  if (typeof structuredClone === 'function') return structuredClone(workflow)
  return JSON.parse(JSON.stringify(workflow)) as Record<string, any>
}

function nextNodeId(workflow: Record<string, any>): string {
  let candidate = Object.keys(workflow).reduce((max, id) => {
    const parsed = Number(id)
    return Number.isInteger(parsed) && parsed >= 0 ? Math.max(max, parsed) : max
  }, 0) + 1

  while (String(candidate) in workflow) candidate++
  return String(candidate)
}

function snapToLatentGrid(value: number): number {
  return Math.max(64, Math.round(value / 8) * 8)
}

export function nativeHiresFinalSize(
  baseWidth: number,
  baseHeight: number,
  scale: number,
): { width: number; height: number } {
  if (!Number.isFinite(baseWidth) || !Number.isFinite(baseHeight) || baseWidth < 64 || baseHeight < 64) {
    throw new NativeHiresFixError('Native HiRes needs a valid base width and height of at least 64 px.')
  }
  if (!Number.isFinite(scale) || scale <= 1 || scale > 3) {
    throw new NativeHiresFixError('Native HiRes scale must be greater than 1.0 and no more than 3.0.')
  }

  const width = snapToLatentGrid(baseWidth * scale)
  const height = snapToLatentGrid(baseHeight * scale)

  if (width > 4096 || height > 4096) {
    throw new NativeHiresFixError(
      `Native HiRes would produce ${width}×${height}. Lower the base resolution or upscale factor so both sides stay at or below 4096 px.`,
    )
  }

  return { width, height }
}

/**
 * Adds a native latent-upscale refinement pass to a simple image workflow:
 *
 *   KSampler → LatentUpscale → KSampler (low denoise) → VAEDecode → SaveImage
 *
 * The transform deliberately targets the terminal image decode rather than
 * assuming fixed node IDs, so it works with LU's dynamic/legacy image builders
 * and compatible imported workflows. Workflows whose final image is not fed by
 * a core KSampler are rejected with an actionable message instead of being
 * silently changed incorrectly.
 */
export function applyNativeHiresFix(
  sourceWorkflow: Record<string, any>,
  options: NativeHiresFixOptions,
): NativeHiresFixResult {
  if (!sourceWorkflow || typeof sourceWorkflow !== 'object') {
    throw new NativeHiresFixError('Native HiRes received an invalid ComfyUI workflow.')
  }
  if (!Number.isFinite(options.denoise) || options.denoise <= 0 || options.denoise > 1) {
    throw new NativeHiresFixError('Native HiRes denoise must be greater than 0 and no more than 1.')
  }
  if (!Number.isFinite(options.steps) || options.steps < 1 || options.steps > 200) {
    throw new NativeHiresFixError('Native HiRes steps must be between 1 and 200.')
  }
  if (!UPSCALE_METHODS.has(options.upscaleMethod)) {
    throw new NativeHiresFixError(`Unsupported Native HiRes upscale method: ${options.upscaleMethod}`)
  }

  const { width, height } = nativeHiresFinalSize(
    options.baseWidth,
    options.baseHeight,
    options.scale,
  )
  const workflow = cloneWorkflow(sourceWorkflow)

  if (Object.values(workflow).some((node: any) => node?._meta?.luNativeHiresFix === true)) {
    throw new NativeHiresFixError('This workflow already contains LU Native HiRes nodes.')
  }

  const terminalDecodeIds = new Set<string>()
  for (const node of Object.values(workflow)) {
    if (!node || !IMAGE_OUTPUT_NODES.has(node.class_type)) continue
    const imageRef = node.inputs?.images
    if (!isNodeRef(imageRef)) continue
    const decodeId = String(imageRef[0])
    const decode = workflow[decodeId]
    if (decode && IMAGE_DECODE_NODES.has(decode.class_type)) terminalDecodeIds.add(decodeId)
  }

  if (terminalDecodeIds.size !== 1) {
    throw new NativeHiresFixError(
      terminalDecodeIds.size === 0
        ? 'Native HiRes could not find a final VAEDecode → SaveImage path. Use Auto or a compatible image workflow.'
        : 'Native HiRes found multiple final image decode paths. Use Auto or a workflow with one final image output.',
    )
  }

  const decodeId = [...terminalDecodeIds][0]
  const decode = workflow[decodeId]
  const samplesRef = decode?.inputs?.samples
  if (!isNodeRef(samplesRef)) {
    throw new NativeHiresFixError('Native HiRes could not find the sampler feeding the final image decode.')
  }

  const firstSamplerId = String(samplesRef[0])
  const firstSampler = workflow[firstSamplerId]
  if (!firstSampler || firstSampler.class_type !== 'KSampler') {
    throw new NativeHiresFixError(
      `Native HiRes currently requires a core KSampler before the final decode; this workflow uses ${firstSampler?.class_type ?? 'an unknown node'}.`,
    )
  }

  const requiredInputs = ['model', 'positive', 'negative', 'latent_image']
  const missing = requiredInputs.filter((key) => firstSampler.inputs?.[key] === undefined)
  if (missing.length > 0) {
    throw new NativeHiresFixError(`The final KSampler is missing required inputs: ${missing.join(', ')}.`)
  }

  const upscaleNodeId = nextNodeId(workflow)
  workflow[upscaleNodeId] = {
    class_type: 'LatentUpscale',
    inputs: {
      samples: [firstSamplerId, samplesRef[1]],
      upscale_method: options.upscaleMethod,
      width,
      height,
      crop: 'disabled',
    },
    _meta: {
      title: 'LU Native HiRes — latent upscale',
      luNativeHiresFix: true,
    },
  }

  const samplerNodeId = nextNodeId(workflow)
  workflow[samplerNodeId] = {
    class_type: 'KSampler',
    inputs: {
      ...firstSampler.inputs,
      latent_image: [upscaleNodeId, 0],
      steps: Math.floor(options.steps),
      denoise: options.denoise,
    },
    _meta: {
      title: 'LU Native HiRes — refinement pass',
      luNativeHiresFix: true,
    },
  }

  decode.inputs = {
    ...decode.inputs,
    samples: [samplerNodeId, 0],
  }

  return {
    workflow,
    width,
    height,
    upscaleNodeId,
    samplerNodeId,
  }
}
