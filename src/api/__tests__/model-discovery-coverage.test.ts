/**
 * The image and video tools have to see every model the user actually has.
 *
 * They did not. getImageModels/getVideoModels read two enums, CheckpointLoader
 * and UNETLoader, and UNETLoader lists only .safetensors and .sft. GGUF quants
 * are enumerated by ComfyUI-GGUF's own UnetLoaderGGUF, so a user could install
 * a GGUF bundle straight out of OUR Model Manager, watch it finish, and then be
 * told "No image model installed" by the image tool. Our own catalogue ships
 * Wan video models as GGUF, so this was self-inflicted.
 *
 * These tests pin the merge. They also pin the two rules that keep the merge
 * from over-reaching: an unrecognised UNET is still offered (people install
 * finetunes we have never heard of), and the lane-specific architectures stay
 * out of the general pickers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const localFetch = vi.fn()
vi.mock('../backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend')>()),
  localFetch: (...a: unknown[]) => localFetch(...a),
  // The suite runs in the node environment, so isTauri()'s `window` lookup
  // would throw before we ever reach the enum routing. Browser mode is the
  // right answer here anyway: comfyuiUrl then returns the proxy path we match.
  isTauri: () => false,
  comfyuiUrl: (path: string) => `http://127.0.0.1:8188${path}`,
}))

import { getImageModels, getVideoModels } from '../comfyui'

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

/** Route each /object_info/<Node> request to the right synthetic enum. */
function routeObjectInfo(opts: {
  checkpoints?: string[]
  unets?: string[]
  gguf?: string[]
  ggufInstalled?: boolean
}) {
  const { checkpoints = [], unets = [], gguf = [], ggufInstalled = true } = opts
  localFetch.mockImplementation(async (url: string) => {
    if (url.includes('CheckpointLoaderSimple')) {
      return okJson({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints] } } } })
    }
    if (url.includes('UnetLoaderGGUF')) {
      if (!ggufInstalled) return { ok: false, status: 404, json: async () => ({}) }
      return okJson({ UnetLoaderGGUF: { input: { required: { unet_name: [gguf] } } } })
    }
    if (url.includes('UNETLoader')) {
      return okJson({ UNETLoader: { input: { required: { unet_name: [unets] } } } })
    }
    // filterPartialFiles and anything else: answer empty so nothing is dropped.
    return okJson({})
  })
}

beforeEach(() => {
  localFetch.mockReset()
})

describe('getImageModels sees everything installed', () => {
  it('THE FIX: a GGUF image model is found', async () => {
    routeObjectInfo({ gguf: ['flux1-dev-Q4_K_M.gguf'] })
    const names = (await getImageModels()).map((m) => m.name)
    expect(names).toContain('flux1-dev-Q4_K_M.gguf')
  })

  it('finds checkpoints, safetensors UNETs and GGUF quants together', async () => {
    routeObjectInfo({
      checkpoints: ['juggernautXL_v9.safetensors'],
      unets: ['flux1-schnell-fp8.safetensors'],
      gguf: ['zimage-turbo-Q5_K_M.gguf'],
    })
    const names = (await getImageModels()).map((m) => m.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'juggernautXL_v9.safetensors',
        'flux1-schnell-fp8.safetensors',
        'zimage-turbo-Q5_K_M.gguf',
      ]),
    )
  })

  it('offers a UNET it cannot classify, because the user installed it on purpose', async () => {
    routeObjectInfo({ unets: ['some_brand_new_arch_v2.safetensors'] })
    const names = (await getImageModels()).map((m) => m.name)
    expect(names).toContain('some_brand_new_arch_v2.safetensors')
  })

  it('keeps video models out of the image list', async () => {
    routeObjectInfo({ checkpoints: ['svd_xt_1_1.safetensors'], unets: ['wan2.1_t2v_1.3B.safetensors'] })
    const names = (await getImageModels()).map((m) => m.name)
    expect(names).not.toContain('svd_xt_1_1.safetensors')
    expect(names).not.toContain('wan2.1_t2v_1.3B.safetensors')
  })

  it('keeps the lane architectures out of the image list, as CHECKPOINTS too', async () => {
    // Measured on the Windows box on 2026-08-15: "zeichne mir ein Logo fuer die
    // Startseite" opened the image model picker with exactly two entries,
    // ace_step_1.5_turbo_aio and sd_turbo, and the ACE one was pre-selected
    // because it sorts first. ACE-Step makes MUSIC. Nobody clicks in 90 seconds
    // when the card says it continues on its own, so the AFK case the countdown
    // exists for would have rendered a picture with an audio checkpoint.
    //
    // The UNET loop filters on isImageModelType and gets this right. The
    // checkpoint loop only skipped video types and renamed everything else to
    // sdxl, so the four lane architectures (ace, wans2v, wananimate, wanvace)
    // walked in through the checkpoint door. Distributed as .safetensors
    // checkpoints, which is exactly how our own Model Manager installs them.
    routeObjectInfo({
      checkpoints: ['ace_step_1.5_turbo_aio.safetensors', 'wan2.1_vace_14b.safetensors'],
      unets: ['ace_step_v1_3.5b.safetensors'],
    })
    const names = (await getImageModels()).map((m) => m.name)
    expect(names).toEqual([])
  })

  it('degrades quietly when ComfyUI-GGUF is not installed', async () => {
    routeObjectInfo({ unets: ['flux1-dev.safetensors'], ggufInstalled: false })
    const names = (await getImageModels()).map((m) => m.name)
    expect(names).toEqual(['flux1-dev.safetensors'])
  })

  it('does not list the same model twice when both loaders report it', async () => {
    routeObjectInfo({ unets: ['shared-model.gguf'], gguf: ['shared-model.gguf'] })
    const names = (await getImageModels()).map((m) => m.name)
    expect(names.filter((n) => n === 'shared-model.gguf')).toHaveLength(1)
  })
})

describe('getVideoModels sees everything installed', () => {
  it('THE FIX: a GGUF video model is found', async () => {
    // This is a real bundle in our own catalogue, which is what made the gap
    // embarrassing rather than theoretical.
    routeObjectInfo({ gguf: ['Wan2.1-T2V-14B-NSFW-Q4_K_M.gguf'] })
    const names = (await getVideoModels()).map((m) => m.name)
    expect(names).toContain('Wan2.1-T2V-14B-NSFW-Q4_K_M.gguf')
  })

  it('finds a video checkpoint and a GGUF UNET together', async () => {
    routeObjectInfo({
      checkpoints: ['svd_xt_1_1.safetensors'],
      gguf: ['wan2.2_i2v_rapid_aio-Q4_K_M.gguf'],
    })
    const names = (await getVideoModels()).map((m) => m.name)
    expect(names).toEqual(
      expect.arrayContaining(['svd_xt_1_1.safetensors', 'wan2.2_i2v_rapid_aio-Q4_K_M.gguf']),
    )
  })

  it('keeps image models out of the video list', async () => {
    routeObjectInfo({ checkpoints: ['juggernautXL_v9.safetensors'], gguf: ['flux1-dev-Q4_K_M.gguf'] })
    const names = (await getVideoModels()).map((m) => m.name)
    expect(names).toEqual([])
  })
})
