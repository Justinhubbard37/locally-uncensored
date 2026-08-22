/**
 * GH #113, JonnFlauty (Windows 11, RTX 5070 Ti, "unfiltered models doesn't
 * shown as installed, even if the downloaded model has a checkmark and say's
 * installed").
 *
 * A video download failed midway, he retried, and afterwards the model was
 * missing from Installed while "every model in the list shown retry".
 *
 * The download store is keyed by filename and bundles share files: seven of
 * the thirteen video bundles ship the same umt5_xxl_fp8_e4m3fn_scaled text
 * encoder, six the same wan_2.1_vae. One attempt on one bundle therefore
 * wrote rows that every other bundle in the list read as if they were about
 * itself. Both halves of his report come out of that one fact.
 *
 * Run: npx vitest run src/lib/__tests__/bundle-state.test.ts
 */
import { describe, it, expect } from 'vitest'
import { bundleIsComplete, bundleIsDownloading, bundleHasErrors } from '../bundle-state'

/** The three files of Wan 2.2 Rapid AIO (Uncensored I2V, GGUF), the bundle
 *  from the issue. The last two are the shared ones. */
const RAPID = [
  { filename: 'wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf' },
  { filename: 'wan_2.1_vae.safetensors' },
  { filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors' },
]

/** Wan 2.1 14B FP8, the bundle that did install for him. Shares two files. */
const WAN21 = [
  { filename: 'wan2.1_t2v_14B_fp8_scaled.safetensors' },
  { filename: 'wan_2.1_vae.safetensors' },
  { filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors' },
]

const rows = (m: Record<string, string>) =>
  Object.fromEntries(Object.entries(m).map(([k, status]) => [k, { status }]))

/** What one finished install of Wan 2.1 leaves behind in the store. */
const AFTER_WAN21 = rows({
  'wan2.1_t2v_14B_fp8_scaled.safetensors': 'complete',
  'wan_2.1_vae.safetensors': 'complete',
  'umt5_xxl_fp8_e4m3fn_scaled.safetensors': 'complete',
})

describe('a bundle reads its own rows, not its neighbours', () => {
  it('one finished install does not put Retry on every other card', () => {
    // Rapid AIO was never touched here. Its own model file has no row at all,
    // the two shared files are complete because Wan 2.1 finished. The old
    // rule saw "some complete, not all" and offered Retry, on this card and
    // on every other Wan card in the list.
    expect(bundleHasErrors(RAPID, AFTER_WAN21, false)).toBe(false)
    expect(bundleIsComplete(RAPID, AFTER_WAN21, false)).toBe(false)
    expect(bundleIsDownloading(RAPID, AFTER_WAN21)).toBe(false)
  })

  it('NEGATIVE CONTROL: the old rule called that untouched bundle half broken', () => {
    // The old expression, replayed on the same state. This is the whole of
    // the "every model in the list shown retry" half of the report.
    const hasAnyRow = RAPID.some((f) => AFTER_WAN21[f.filename])
    const someComplete = RAPID.some((f) => AFTER_WAN21[f.filename]?.status === 'complete')
    const allComplete = RAPID.every((f) => AFTER_WAN21[f.filename]?.status === 'complete')
    expect(hasAnyRow && someComplete && !allComplete).toBe(true)
  })

  it('a bundle that really did stop halfway still says Retry', () => {
    // Same shape, one difference that matters: the missing file has a row, so
    // this bundle WAS attempted and did not finish.
    const halfway = { ...AFTER_WAN21, 'wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf': { status: 'paused' } }
    expect(bundleHasErrors(RAPID, halfway, false)).toBe(true)
  })

  it('an error row is a dead stop whatever file it sits on', () => {
    // A shared file that cannot be fetched blocks this bundle exactly as much
    // as its own model would, so that half of the old rule stays.
    const teFailed = rows({ 'umt5_xxl_fp8_e4m3fn_scaled.safetensors': 'error' })
    expect(bundleHasErrors(RAPID, teFailed, false)).toBe(true)
    expect(bundleHasErrors(WAN21, teFailed, false)).toBe(true)
  })

  it('a bundle that is on disk is installed, even with a stale error row nearby', () => {
    // The other half of the report. The disk verdict already means every file
    // is there at full size AND visible to the running ComfyUI, so a leftover
    // error row on a shared filename has nothing to say about it. The old
    // order asked the error row first and answered "not installed".
    const teFailed = rows({ 'umt5_xxl_fp8_e4m3fn_scaled.safetensors': 'error' })
    expect(bundleIsComplete(WAN21, teFailed, true)).toBe(true)
  })

  it('NEGATIVE CONTROL: the old rule hid an installed bundle behind that row', () => {
    const teFailed = rows({ 'umt5_xxl_fp8_e4m3fn_scaled.safetensors': 'error' })
    const oldHasError = WAN21.some((f) => teFailed[f.filename]?.status === 'error')
    expect(oldHasError).toBe(true) // and the old code returned false right here
  })

  it('a session where every file finished counts without asking the disk', () => {
    // The disk check runs on an event and on tab changes, so the store is the
    // faster answer right after an install. Kept exactly as it was.
    expect(bundleIsComplete(WAN21, AFTER_WAN21, false)).toBe(true)
  })

  it('a bundle with no named files is never installed', () => {
    expect(bundleIsComplete([], {}, false)).toBe(false)
    expect(bundleIsComplete([{}], {}, false)).toBe(false)
  })

  it('downloading is about this bundle and only reads live rows', () => {
    const live = { ...AFTER_WAN21, 'wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf': { status: 'downloading' } }
    expect(bundleIsDownloading(RAPID, live)).toBe(true)
    expect(bundleIsDownloading(WAN21, live)).toBe(false)
    const connecting = rows({ 'wan_2.1_vae.safetensors': 'connecting' })
    expect(bundleIsDownloading(RAPID, connecting)).toBe(true)
  })

  it('Clear leaves a card that offers Install again', () => {
    // clearBundle dismisses every row of the bundle. Nothing then claims this
    // bundle is half anything, which is what the_mr_pickles needed.
    expect(bundleHasErrors(RAPID, {}, false)).toBe(false)
    expect(bundleIsComplete(RAPID, {}, false)).toBe(false)
  })
})
