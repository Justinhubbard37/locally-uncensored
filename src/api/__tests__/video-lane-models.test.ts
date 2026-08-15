/** Picker (ModelChip) and the missing-models gate (Stage) share
 *  videoLaneModels(). Before they did, a box whose only video model was SVD
 *  showed "No matches" in the T2V picker while the gate counted "1 video
 *  model" and withheld the starter-bundle card (David 2026-08-01). */
import { describe, it, expect } from 'vitest'
import { canRunVideoIntent, videoLaneModels, bundleForVideoIntent, type ClassifiedModel } from '../comfyui'

const m = (name: string): ClassifiedModel => ({ name, type: 'unknown', source: 'checkpoint' })

const SVD_ONLY = [m('svd_xt_1_1.safetensors')]
const NSFW_GGUF = m('nsfw_wan_14b_e15_q4_k.gguf')
const RAPID_AIO = m('wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf')

describe('videoLaneModels', () => {
  it('the T2V lane drops i2v-only models, so SVD alone means an empty lane', () => {
    expect(videoLaneModels(SVD_ONLY, 'video')).toEqual([])
  })

  it('the T2V lane keeps a t2v finetune like the NSFW Wan GGUF', () => {
    expect(videoLaneModels([...SVD_ONLY, NSFW_GGUF], 'video')).toEqual([NSFW_GGUF])
  })

  it('Animate keeps SVD and the rapid AIO i2v merge, drops the pure t2v', () => {
    const got = videoLaneModels([...SVD_ONLY, NSFW_GGUF, RAPID_AIO], 'animate')
    expect(got).toEqual([...SVD_ONLY, RAPID_AIO])
  })

  it('Extend gates like Animate (i2v-capable)', () => {
    expect(videoLaneModels([NSFW_GGUF], 'extend')).toEqual([])
    expect(videoLaneModels([RAPID_AIO], 'extend')).toEqual([RAPID_AIO])
  })
})

describe('canRunVideoIntent (submit uses this before the model list arrives)', () => {
  it('a persisted SVD pick must not reach a T2V build, but may Animate', () => {
    expect(canRunVideoIntent('svd_xt_1_1.safetensors', 'video')).toBe(false)
    expect(canRunVideoIntent('svd_xt_1_1.safetensors', 'animate')).toBe(true)
  })

  it('the NSFW Wan GGUF is the mirror image: T2V yes, Animate no', () => {
    expect(canRunVideoIntent(NSFW_GGUF.name, 'video')).toBe(true)
    expect(canRunVideoIntent(NSFW_GGUF.name, 'animate')).toBe(false)
  })
})

/** The third place that has to obey the same rule, and the one that did not.
 *
 * Measured on the Windows box 2026-08-15 on Extend Video: the card offered the
 * 9.2 GB Wan 2.1 bundle, the download finished, ComfyUI listed every file, and
 * the card came straight back. The bundle carries a **T2V** model and Extend is
 * an i2v lane, so it could never satisfy the gate that put the card there. An
 * hour later it still said "Download & install". This is the other half of the
 * C8 report from Voxyl AI and Aldrich Ironhart. */
describe('bundleForVideoIntent (the installer picks what the gate accepts)', () => {
  const wan21 = {
    name: 'Wan 2.1 · 1.3B (Lightweight)',
    files: [
      { filename: 'wan2.1_t2v_1.3B_bf16.safetensors', subfolder: 'diffusion_models' },
      { filename: 'wan_2.1_vae.safetensors', subfolder: 'vae' },
      { filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders' },
    ],
  }
  const wan22 = {
    name: 'Wan 2.2 · TI2V 5B (Image + Text to Video)',
    files: [
      { filename: 'wan2.2_ti2v_5B_fp16.safetensors', subfolder: 'diffusion_models' },
      { filename: 'wan2.2_vae.safetensors', subfolder: 'vae' },
    ],
  }
  const alle = [wan21, wan22]

  it('the plain Video tab keeps the light t2v bundle', () => {
    expect(bundleForVideoIntent(alle, 'video')).toBe(wan21)
  })

  it('Animate and Extend get an i2v bundle, never the t2v one', () => {
    expect(bundleForVideoIntent(alle, 'animate')).toBe(wan22)
    expect(bundleForVideoIntent(alle, 'extend')).toBe(wan22)
  })

  it('whatever it picks, the gate that opened the card accepts it', () => {
    for (const intent of ['video', 'animate', 'extend']) {
      const b = bundleForVideoIntent(alle, intent)!
      const modell = b.files.find((f) => f.subfolder === 'diffusion_models')!.filename
      expect(videoLaneModels([m(modell)], intent)).toHaveLength(1)
    }
  })

  it('a VAE named like nothing in particular never decides the pick', () => {
    const nurVae = [{ name: 'kein Modell', files: [{ filename: 'wan_2.1_vae.safetensors', subfolder: 'vae' }] }]
    expect(bundleForVideoIntent(nurVae, 'video')).toBeUndefined()
  })

  it('no i2v bundle at all means nothing to offer, not the wrong thing', () => {
    expect(bundleForVideoIntent([wan21], 'extend')).toBeUndefined()
  })
})
