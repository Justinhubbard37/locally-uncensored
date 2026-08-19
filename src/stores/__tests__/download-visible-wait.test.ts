/**
 * C8, the Model Manager half.
 *
 * A finished download is not a finished install. ComfyUI serves what its own
 * directory scan has picked up, and on the big files that scan is still
 * running when the last byte lands. Create learned to wait for that on
 * 2026-08-13 (Voxyl AI with a screenshot, confirmed by Aldrich Ironhart) and
 * the Model Manager path never did: the poller fired one event on the
 * completion transition, useModels ran one fetch against a stale
 * /object_info, and the model was simply absent from the Installed tab and
 * every picker until the user reloaded by hand. Same slow scan, same too
 * short window, quieter symptom.
 *
 * The probe both paths use now lives in discover.ts (modelsNotVisibleInComfy)
 * so there is one of it, not two.
 *
 * Run: npx vitest run src/stores/__tests__/download-visible-wait.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

const getDownloadProgress = vi.fn(async () => ({}) as Record<string, unknown>)
const modelsNotVisibleInComfy = vi.fn<(wanted: string[]) => Promise<string[]>>(async () => [])
const lookupFileMeta = vi.fn<(filename: string) => { url: string; subfolder: string } | null>(() => null)
const checkComfyConnection = vi.fn(async () => true)
const refreshComfyModels = vi.fn(async () => true)

vi.mock('../../api/discover', () => ({
  getDownloadProgress: (...a: unknown[]) => getDownloadProgress(...(a as [])),
  pauseDownload: vi.fn(async () => {}),
  cancelDownload: vi.fn(async () => {}),
  resumeDownload: vi.fn(async () => {}),
  startModelDownload: vi.fn(async () => {}),
  startModelDownloadToPath: vi.fn(async () => {}),
  lookupFileMeta: (...a: unknown[]) => lookupFileMeta(...(a as [string])),
  modelsNotVisibleInComfy: (...a: unknown[]) => modelsNotVisibleInComfy(...(a as [string[]])),
  ENUM_SUBFOLDERS: new Set(['checkpoints', 'diffusion_models', 'vae', 'text_encoders']),
}))

vi.mock('../../api/comfyui', () => ({
  checkComfyConnection: (...a: unknown[]) => checkComfyConnection(...(a as [])),
  refreshComfyModels: (...a: unknown[]) => refreshComfyModels(...(a as [])),
}))

// The real loop, on a short clock. Sleeping the production 3 seconds twenty
// times is the one thing here a test has no reason to reproduce; everything
// else, including the attempt budget, is the shipped code.
vi.mock('../../lib/bundle-install', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/bundle-install')>()
  return {
    ...real,
    waitForModelsVisible: (opts: Parameters<typeof real.waitForModelsVisible>[0]) =>
      real.waitForModelsVisible({ ...opts, delayMs: 1 }),
  }
})

type StoreModule = typeof import('../downloadStore')
let useDownloadStore: StoreModule['useDownloadStore']
let win: EventTarget

beforeAll(async () => {
  // vitest runs this suite in the node environment, and the store dispatches
  // its "a model arrived" event on window. Give it one before the module is
  // evaluated, because it registers listeners at import time.
  win = new EventTarget()
  ;(globalThis as unknown as { window: EventTarget }).window = win
  ;({ useDownloadStore } = await import('../downloadStore'))
})

/** One finished download, exactly as the Rust progress map reports it. */
function completed(filename: string) {
  return { [filename]: { progress: 1, total: 1, speed: 0, filename, status: 'complete' } }
}

/** Every filename the store announced, in order. */
function recordAnnouncements() {
  const seen: Array<string | undefined> = []
  const handler = (e: Event) => seen.push((e as CustomEvent<{ filename?: string }>).detail?.filename)
  win.addEventListener('comfyui-model-downloaded', handler)
  return { seen, stop: () => win.removeEventListener('comfyui-model-downloaded', handler) }
}

/** The announce loop is deliberately fire and forget, so a test has to wait
 *  for the thing it is asserting rather than for a fixed number of
 *  milliseconds. A 20 round budget on a 1 ms clock is still 20 awaits deep. */
async function until(pred: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  await new Promise((r) => setTimeout(r, 10))
}

/** Wait until no further round happens. Used to stop one test's loop from
 *  running inside the next one, which is the only way these can interfere. */
async function quiet(): Promise<void> {
  let last = -1
  for (let i = 0; i < 400 && refreshComfyModels.mock.calls.length !== last; i++) {
    last = refreshComfyModels.mock.calls.length
    await new Promise((r) => setTimeout(r, 10))
  }
}

const settle = () => new Promise((r) => setTimeout(r, 60))

function seed(filename: string, subfolder: string) {
  useDownloadStore.setState({
    downloads: {},
    downloadMeta: { [filename]: { url: 'https://example.test/m', subfolder } },
  })
}

describe('a finished download waits for ComfyUI to list it, in the Model Manager too', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkComfyConnection.mockResolvedValue(true)
    refreshComfyModels.mockResolvedValue(true)
    lookupFileMeta.mockReturnValue(null)
    useDownloadStore.getState().stopPolling()
    useDownloadStore.setState({ downloads: {}, downloadMeta: {} })
  })

  afterEach(async () => {
    // Whatever a test left in flight, let it see a visible file and stop.
    modelsNotVisibleInComfy.mockResolvedValue([])
    await quiet()
  })

  it('the event says which file arrived', async () => {
    // Nothing downstream could wait for a specific model before, because the
    // event carried no detail at all.
    modelsNotVisibleInComfy.mockResolvedValue([])
    getDownloadProgress.mockResolvedValue(completed('sdxl.safetensors'))
    seed('sdxl.safetensors', 'checkpoints')
    const rec = recordAnnouncements()

    await useDownloadStore.getState().refresh()
    await settle()
    rec.stop()

    expect(rec.seen).toEqual(['sdxl.safetensors'])
  })

  it('it keeps announcing until ComfyUI lists the file', async () => {
    // Three rounds of scan, which is what a 12 GB video bundle looks like.
    let rounds = 0
    modelsNotVisibleInComfy.mockImplementation(async () =>
      ++rounds >= 3 ? [] : ['wan2.2_s2v_14B_fp8.safetensors'],
    )
    getDownloadProgress.mockResolvedValue(completed('wan2.2_s2v_14B_fp8.safetensors'))
    seed('wan2.2_s2v_14B_fp8.safetensors', 'diffusion_models')
    const rec = recordAnnouncements()

    await useDownloadStore.getState().refresh()
    await until(() => rounds >= 3)
    rec.stop()

    // One on the completion transition plus one per round that rescanned.
    expect(rec.seen).toEqual([
      'wan2.2_s2v_14B_fp8.safetensors',
      'wan2.2_s2v_14B_fp8.safetensors',
      'wan2.2_s2v_14B_fp8.safetensors',
    ])
    expect(refreshComfyModels).toHaveBeenCalledTimes(2)
  })

  it('NEGATIVE CONTROL: the one event the old path sent arrives too early', async () => {
    // A listener shaped like useModels: it refetches ComfyUI every time the
    // event lands. ComfyUI's own scan finishes on the second rescan here. The
    // FIRST event is all the old code ever sent, and the list it hands that
    // listener does not have the file in it, so a path that stops there ends
    // with the model missing from the Installed tab and every picker. The
    // later announcements are the fix, and the last one carries the model.
    const FILE = 'wan2.2_s2v_14B_fp8.safetensors'
    let scanDone = false
    let rescans = 0
    refreshComfyModels.mockImplementation(async () => {
      if (++rescans >= 2) scanDone = true
      return true
    })
    modelsNotVisibleInComfy.mockImplementation(async () => (scanDone ? [] : [FILE]))
    getDownloadProgress.mockResolvedValue(completed(FILE))
    seed(FILE, 'diffusion_models')

    // What ComfyUI would answer that listener at the moment it refetches.
    const listAtRefetch: string[][] = []
    const handler = () => listAtRefetch.push(scanDone ? [FILE] : [])
    win.addEventListener('comfyui-model-downloaded', handler)
    await useDownloadStore.getState().refresh()
    await until(() => scanDone)
    win.removeEventListener('comfyui-model-downloaded', handler)

    expect(listAtRefetch[0]).toEqual([])
    expect(listAtRefetch[listAtRefetch.length - 1]).toEqual([FILE])
  })

  it('gives up after the budget instead of asking ComfyUI forever', async () => {
    modelsNotVisibleInComfy.mockResolvedValue(['ghost.safetensors'])
    getDownloadProgress.mockResolvedValue(completed('ghost.safetensors'))
    seed('ghost.safetensors', 'vae')
    const rec = recordAnnouncements()

    await useDownloadStore.getState().refresh()
    await until(() => refreshComfyModels.mock.calls.length >= 20)
    rec.stop()

    // waitForModelsVisible's own default budget, unchanged by this caller, and
    // it stops there rather than polling a stuck engine for good.
    expect(refreshComfyModels).toHaveBeenCalledTimes(20)
    expect(rec.seen).toHaveLength(21)
  })

  it('a subfolder ComfyUI never enumerates is not waited on at all', async () => {
    // loras, upscale models and the GGUF text downloads do not appear in the
    // enums the probe reads, so waiting on one would be a minute of certain
    // failure. The single event still fires, exactly as before.
    modelsNotVisibleInComfy.mockResolvedValue([])
    getDownloadProgress.mockResolvedValue(completed('mychar.safetensors'))
    seed('mychar.safetensors', 'loras')
    const rec = recordAnnouncements()

    await useDownloadStore.getState().refresh()
    await settle()
    rec.stop()

    expect(rec.seen).toEqual(['mychar.safetensors'])
    expect(checkComfyConnection).not.toHaveBeenCalled()
    expect(modelsNotVisibleInComfy).not.toHaveBeenCalled()
  })

  it('an engine that is not running costs one probe, not the whole budget', async () => {
    checkComfyConnection.mockResolvedValue(false)
    getDownloadProgress.mockResolvedValue(completed('sdxl.safetensors'))
    seed('sdxl.safetensors', 'checkpoints')
    const rec = recordAnnouncements()

    await useDownloadStore.getState().refresh()
    await settle()
    rec.stop()

    expect(rec.seen).toEqual(['sdxl.safetensors'])
    expect(modelsNotVisibleInComfy).not.toHaveBeenCalled()
    expect(refreshComfyModels).not.toHaveBeenCalled()
  })

  it('a file that lands twice does not stack two waits', async () => {
    // dismiss() drops the row, so the next poll reads the completion as new
    // again. Without the guard that starts a second full wait on top of the
    // first, and the poller ticks once a second.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    modelsNotVisibleInComfy.mockImplementation(async () => { await gate; return [] })
    getDownloadProgress.mockResolvedValue(completed('sdxl.safetensors'))
    seed('sdxl.safetensors', 'checkpoints')

    await useDownloadStore.getState().refresh()
    // Same completion read as new, while the first wait is still in flight.
    useDownloadStore.setState({ downloads: {} })
    await useDownloadStore.getState().refresh()
    release()
    await settle()

    expect(modelsNotVisibleInComfy).toHaveBeenCalledTimes(1)
  })

  it('a download with no stored meta falls back to the bundle lookup', async () => {
    // A download restored from a previous session has no downloadMeta entry,
    // and without the fallback its subfolder is unknown and the wait is
    // skipped for a file that very much needs it.
    modelsNotVisibleInComfy.mockResolvedValue([])
    lookupFileMeta.mockReturnValue({ url: 'https://example.test/m', subfolder: 'checkpoints' })
    getDownloadProgress.mockResolvedValue(completed('restored.safetensors'))
    useDownloadStore.setState({ downloads: {}, downloadMeta: {} })

    await useDownloadStore.getState().refresh()
    await settle()

    expect(lookupFileMeta).toHaveBeenCalledWith('restored.safetensors')
    expect(modelsNotVisibleInComfy).toHaveBeenCalledWith(['restored.safetensors'])
  })
})
