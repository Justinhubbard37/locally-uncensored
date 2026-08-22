/**
 * C8, the third path: the install click.
 *
 * Create waits for ComfyUI's directory scan (2.6.5) and the Model Manager's
 * download poller waits too (2.6.6). installBundleComplete did not. It asked
 * ComfyUI once, cached the answer, and judged every file that check_model_sizes
 * reported as complete on disk from that single lookup. In the C8 window, the
 * seconds after a big download lands while ComfyUI is still scanning, the
 * answer for a file that is perfectly fine is "not listed", and the video
 * bundles share files, so starting an overlapping bundle right after one
 * finished produced a red row claiming LU and ComfyUI use different model
 * folders. They do not. The scan was simply still running.
 *
 * The budget here is deliberately short, three rounds against the other two
 * paths' twenty: this runs inside a click, an old file answers on the first
 * lookup with no waiting at all, and the download poller keeps watching the
 * same file with the full budget.
 *
 * Run: npx vitest run src/api/__tests__/bundle-install-visible-wait.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { ModelBundle } from '../discover'

const backendCall = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()
const getCheckpoints = vi.fn<() => Promise<string[]>>(async () => [])
const refreshComfyModels = vi.fn<(maxAttempts?: number) => Promise<boolean>>(async () => true)

vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...(a as [string, unknown])),
  fetchExternal: vi.fn(),
}))

vi.mock('../comfyui', () => ({
  getCheckpoints: () => getCheckpoints(),
  getDiffusionModels: async () => [],
  getVAEModels: async () => [],
  getCLIPModels: async () => [],
  getGgufUnetModels: async () => [],
  filterPartialFiles: async (names: string[]) => new Set(names),
  refreshComfyModels: (...a: unknown[]) => refreshComfyModels(...(a as [number])),
}))

// The real loop, on a short clock. Sleeping the production 1.5 seconds is the
// one thing here a test has no reason to reproduce; the attempt budget is the
// shipped code.
vi.mock('../../lib/bundle-install', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/bundle-install')>()
  return {
    ...real,
    waitForModelsVisible: (opts: Parameters<typeof real.waitForModelsVisible>[0]) =>
      real.waitForModelsVisible({ ...opts, delayMs: 1 }),
  }
})

let installBundleComplete: typeof import('../discover').installBundleComplete
let win: EventTarget

beforeAll(async () => {
  // vitest runs this suite in the node environment and the install dispatches
  // its verdicts on window.
  win = new EventTarget()
  ;(globalThis as unknown as { window: EventTarget }).window = win
  ;({ installBundleComplete } = await import('../discover'))
})

const VIDEO = 'wan2.2_s2v_14B_fp8.safetensors'
const VAE = 'wan_2.1_vae.safetensors'

function bundleOf(files: Array<{ filename: string; subfolder: string }>): ModelBundle {
  return {
    name: 'Extend Video',
    description: '',
    tags: [],
    totalSizeGB: 12,
    vramRequired: '12 GB',
    files: files.map((f) => ({
      name: '', description: '', pulls: '', tags: [], updated: '',
      downloadUrl: `https://example.test/${f.filename}`,
      filename: f.filename,
      subfolder: f.subfolder,
      sizeGB: 6,
    })),
  } as unknown as ModelBundle
}

/** Every verdict the install announced about a file already on disk. */
function recordVerdicts() {
  const seen: Array<{ type: string; filename?: string }> = []
  const push = (e: Event) =>
    seen.push({ type: e.type, filename: (e as CustomEvent<{ filename?: string }>).detail?.filename })
  win.addEventListener('comfyui-download-exists', push)
  win.addEventListener('comfyui-model-invisible', push)
  return {
    seen,
    stop: () => {
      win.removeEventListener('comfyui-download-exists', push)
      win.removeEventListener('comfyui-model-invisible', push)
    },
  }
}

/** ComfyUI lists nothing on the first read and everything from the second on,
 *  which is what the tail of its directory scan looks like from outside. */
function scanFinishesAfterOneRound(...names: string[]) {
  let reads = 0
  getCheckpoints.mockImplementation(async () => (++reads > 1 ? names : []))
}

describe('a file complete on disk waits out the ComfyUI scan before it is called invisible', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    refreshComfyModels.mockResolvedValue(true)
    // The disk check says every file of the bundle is there at full size.
    backendCall.mockImplementation(async (cmd, args) => {
      if (cmd !== 'check_model_sizes') return undefined
      const files = (args as { files: Array<{ filename: string }> }).files
      return files.map((f) => ({ filename: f.filename, exists: true, complete: true }))
    })
  })

  it('a file the engine already lists is skipped without any waiting', async () => {
    getCheckpoints.mockResolvedValue([VIDEO])
    const rec = recordVerdicts()

    await installBundleComplete(bundleOf([{ filename: VIDEO, subfolder: 'diffusion_models' }]))
    rec.stop()

    expect(rec.seen).toEqual([{ type: 'comfyui-download-exists', filename: VIDEO }])
    // One lookup, no rescan round. This is the common case and it must stay free.
    expect(getCheckpoints).toHaveBeenCalledTimes(1)
    expect(refreshComfyModels.mock.calls.filter((c) => c[0] === 1)).toHaveLength(0)
  })

  it('a scan that finishes a moment later is not a folder mismatch', async () => {
    scanFinishesAfterOneRound(VIDEO)
    const rec = recordVerdicts()

    await installBundleComplete(bundleOf([{ filename: VIDEO, subfolder: 'diffusion_models' }]))
    rec.stop()

    expect(rec.seen).toEqual([{ type: 'comfyui-download-exists', filename: VIDEO }])
    // The initial lookup plus the one rescan round it took.
    expect(getCheckpoints).toHaveBeenCalledTimes(2)
  })

  it('NEGATIVE CONTROL: the single lookup the old path made answers "not listed"', async () => {
    // The exact moment the old code decided: ComfyUI's scan has not reached the
    // file yet, so the one and only lookup says it is invisible. A path that
    // stops there dispatches comfyui-model-invisible, which downloadStore turns
    // into a red "LU and ComfyUI are using different model folders" row for a
    // file that is on disk, intact, and about to be listed. Without the wait
    // this test goes red on the last expect.
    const answers: string[][] = []
    getCheckpoints.mockImplementation(async () => {
      const list = answers.length === 0 ? [] : [VIDEO]
      answers.push(list)
      return list
    })
    const rec = recordVerdicts()

    await installBundleComplete(bundleOf([{ filename: VIDEO, subfolder: 'diffusion_models' }]))
    rec.stop()

    expect(answers[0]).toEqual([])
    expect(answers[answers.length - 1]).toEqual([VIDEO])
    expect(rec.seen.map((v) => v.type)).not.toContain('comfyui-model-invisible')
  })

  it('a file the engine never lists still reports the folder mismatch, after the budget', async () => {
    getCheckpoints.mockResolvedValue([])
    const rec = recordVerdicts()

    await installBundleComplete(bundleOf([{ filename: VIDEO, subfolder: 'diffusion_models' }]))
    rec.stop()

    expect(rec.seen).toEqual([{ type: 'comfyui-model-invisible', filename: VIDEO }])
    // The initial lookup plus three rescan rounds, then it stops asking.
    expect(getCheckpoints).toHaveBeenCalledTimes(4)
    expect(refreshComfyModels.mock.calls.filter((c) => c[0] === 1)).toHaveLength(3)
  })

  it('the rescan carries the next file of the same bundle, no second wait', async () => {
    // Video bundles share files. Once one wait has seen the scan finish, every
    // later file is judged against that refreshed list instead of starting its
    // own wait.
    scanFinishesAfterOneRound(VIDEO, VAE)
    const rec = recordVerdicts()

    await installBundleComplete(
      bundleOf([
        { filename: VIDEO, subfolder: 'diffusion_models' },
        { filename: VAE, subfolder: 'vae' },
      ]),
    )
    rec.stop()

    expect(rec.seen).toEqual([
      { type: 'comfyui-download-exists', filename: VIDEO },
      { type: 'comfyui-download-exists', filename: VAE },
    ])
    expect(getCheckpoints).toHaveBeenCalledTimes(2)
  })

  it('a subfolder ComfyUI never enumerates is not judged at all', async () => {
    // loras and upscale models do not appear in these lists, so waiting on one
    // would be certain failure on a click.
    const rec = recordVerdicts()

    await installBundleComplete(bundleOf([{ filename: 'mychar.safetensors', subfolder: 'loras' }]))
    rec.stop()

    expect(rec.seen).toEqual([{ type: 'comfyui-download-exists', filename: 'mychar.safetensors' }])
    expect(getCheckpoints).not.toHaveBeenCalled()
  })

  it('an engine that cannot be reached is not a verdict, and costs no budget', async () => {
    getCheckpoints.mockRejectedValue(new Error('ECONNREFUSED'))
    const rec = recordVerdicts()

    await installBundleComplete(bundleOf([{ filename: VIDEO, subfolder: 'diffusion_models' }]))
    rec.stop()

    expect(rec.seen).toEqual([{ type: 'comfyui-download-exists', filename: VIDEO }])
    expect(getCheckpoints).toHaveBeenCalledTimes(1)
    expect(refreshComfyModels.mock.calls.filter((c) => c[0] === 1)).toHaveLength(0)
  })
})
