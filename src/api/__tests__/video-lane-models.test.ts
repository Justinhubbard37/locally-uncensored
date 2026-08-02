/** Picker (ModelChip) and the missing-models gate (Stage) share
 *  videoLaneModels(). Before they did, a box whose only video model was SVD
 *  showed "No matches" in the T2V picker while the gate counted "1 video
 *  model" and withheld the starter-bundle card (David 2026-08-01). */
import { describe, it, expect } from 'vitest'
import { canRunVideoIntent, videoLaneModels, type ClassifiedModel } from '../comfyui'

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
