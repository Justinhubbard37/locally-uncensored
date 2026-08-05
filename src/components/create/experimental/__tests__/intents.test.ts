import { describe, it, expect } from 'vitest'
import { INTENTS, INTENT_MAP, isIntentAvailable, isIntentLocked, visibleIntents } from '../intents'
import { LOCAL_LANE_OPS } from '../../../../stores/createStore'

// David 2026-07-10 made the advanced ops cloud-only; David 2026-07-12 brought
// Edit BACK to local as the 4th local tab (checkpoint mask inpaint —
// VAEEncodeForInpaint / InpaintModelConditioning); David 2026-07-17 brought
// Animate (local I2V) back as the 5th. 2.5.8 gives FOUR specialized categories
// REAL local lanes (hasLocalLane): music / lipsync / extend / motion on core
// ComfyUI node families (motion additionally needs the DWPose pack, which
// loads fine on Windows via the OpenCV CPU fallback). Upscale and eraser
// stay hosted-only. Character was cloud-first through 2.5.x; 2.6.0 ships the
// musubi trainer runtime (trainer.rs), so its train lane is local now too.
/** The pills the bar shows, in order. */
const shown = (backend: 'local' | 'cloud', mlxHost: boolean) =>
  visibleIntents(backend, mlxHost).map((m) => m.id)
/** The pills a user can actually select (no cloud-teaser lock). */
const unlocked = (backend: 'local' | 'cloud', mlxHost: boolean) =>
  visibleIntents(backend, mlxHost).filter((m) => !isIntentLocked(m, backend, mlxHost)).map((m) => m.id)
/** The pills shown as locked, cloud-tagged teasers. */
const teasers = (backend: 'local' | 'cloud', mlxHost: boolean) =>
  visibleIntents(backend, mlxHost).filter((m) => isIntentLocked(m, backend, mlxHost)).map((m) => m.id)

describe('intent cloud gating', () => {
  it('upscale and eraser stay hosted-only (no local lane)', () => {
    for (const id of ['upscale', 'eraser'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
      expect(INTENT_MAP[id].hasLocalLane, id).toBeUndefined()
    }
  })

  it('image, edit, video, removebg and animate stay available locally', () => {
    for (const id of ['image', 'edit', 'video', 'removebg', 'animate'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBeUndefined()
    }
  })

  it('the dual lanes carry a hosted clip AND a local lane (character joined in 2.6.0)', () => {
    for (const id of ['music', 'lipsync', 'extend', 'motion', 'character'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
      expect(INTENT_MAP[id].hasLocalLane, id).toBe(true)
    }
  })

  it('intent metadata mirrors the store LOCAL_LANE_OPS set exactly', () => {
    const fromMeta = INTENTS.filter((m) => m.hasLocalLane).map((m) => m.id).sort()
    expect(fromMeta).toEqual([...LOCAL_LANE_OPS].sort())
  })

  it('the local IntentBar filter keeps the 5 classic tabs plus the 5 lanes selectable', () => {
    const selectable = INTENTS.filter((m) => !m.cloudOnly || m.hasLocalLane).map((m) => m.id)
    expect(selectable).toEqual(['image', 'edit', 'removebg', 'video', 'animate', 'character', 'lipsync', 'music', 'extend', 'motion'])
    // …and that IS what the pure filter reports for a ComfyUI local host.
    expect(unlocked('local', false)).toEqual(selectable)
  })

  it('local edit gates on the inpaint capability + image models', () => {
    expect(INTENT_MAP.edit.capability).toBe('inpaint-nodes')
    expect(INTENT_MAP.edit.requiresModels).toBe('image')
    expect(INTENT_MAP.edit.allowsMask).toBe(true)
    // The fresh-PC Download & install card also covers plain generation.
    expect(INTENT_MAP.image.requiresModels).toBe('image')
    expect(INTENT_MAP.video.requiresModels).toBe('video')
  })

  it('local animate needs a source image and gates on video models', () => {
    expect(INTENT_MAP.animate.needsSource).toBe(true)
    expect(INTENT_MAP.animate.isVideo).toBe(true)
    expect(INTENT_MAP.animate.requiresModels).toBe('video')
  })

  it('the lanes gate on their own model kinds', () => {
    expect(INTENT_MAP.music.requiresModels).toBe('audio')
    expect(INTENT_MAP.lipsync.requiresModels).toBe('lipsync')
    // Extend rides the regular i2v-capable video list (last-frame continue).
    expect(INTENT_MAP.extend.requiresModels).toBe('video')
    // Motion gates on the VACE/Animate model list AND the DWPose pack.
    expect(INTENT_MAP.motion.requiresModels).toBe('motion')
    expect(INTENT_MAP.motion.capability).toBe('dwpose')
    // Character has no requiresModels gate: LocalTrainControls runs its own
    // three gates (trainer env, Z-Image bases, staged photos) instead.
    expect(INTENT_MAP.character.requiresModels).toBeUndefined()
  })
})

// The Mac has NO ComfyUI (hard product rule): its local media is the
// in-process MLX path, which runs plain text-to-image and text-to-video and
// nothing else. Every other lane's "local" implementation is a ComfyUI graph
// (RMBG cutout, inpaint nodes, ACE music, Wan S2V, VACE/DWPose) and every
// source-needing lane additionally stages its input through ComfyUI's
// /upload/image, which does not exist there either. So on a local MLX Mac an
// intent must never render as an active local tab unless MLX really runs it.
describe('intent gating on a local MLX Mac (no ComfyUI)', () => {
  it('only image and video stay real local tabs', () => {
    expect(unlocked('local', true)).toEqual(['image', 'video'])
  })

  it('the hosted-only tools AND the 2.5.8 lanes become cloud teasers', () => {
    // Same locked pill + ", runs on LU Cloud" label the 2.6.0 bar already
    // uses — visible, honest, and it opens the teaser sheet on tap.
    expect(teasers('local', true)).toEqual(['upscale', 'eraser', 'character', 'lipsync', 'music', 'extend', 'motion'])
  })

  it('every Mac teaser has a cloud endpoint to teased about', () => {
    for (const id of teasers('local', true)) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
    }
  })

  it('edit, removebg and animate are hidden rather than shown as dead tabs', () => {
    // No hosted-only flag means no teaser sheet exists for them, and MLX
    // silently DROPS a source + mask (it only takes prompt/steps/seed/size/
    // negative) — which produced an unrelated fresh image instead of an edit.
    // Hiding is the only honest state left.
    const hidden = INTENTS.map((m) => m.id).filter((id) => !shown('local', true).includes(id))
    expect(hidden).toEqual(['edit', 'removebg', 'animate'])
  })

  it('nothing is hidden on cloud or on a ComfyUI local host', () => {
    expect(shown('cloud', true)).toEqual(INTENTS.map((m) => m.id))
    expect(shown('cloud', false)).toEqual(INTENTS.map((m) => m.id))
    expect(shown('local', false)).toEqual(INTENTS.map((m) => m.id))
  })

  it('cloud unlocks every intent regardless of host', () => {
    expect(unlocked('cloud', true)).toEqual(INTENTS.map((m) => m.id))
    expect(teasers('cloud', true)).toEqual([])
  })

  it('a Mac on the cloud backend is unaffected by the MLX rule', () => {
    expect(unlocked('cloud', true)).toEqual(unlocked('cloud', false))
  })

  it("isIntentAvailable gates the result's 'Edit with mask' action the same way", () => {
    // The action force-sets 'edit'; it must vanish exactly where the tab does.
    expect(isIntentAvailable('edit', 'local', true)).toBe(false)
    expect(isIntentAvailable('edit', 'local', false)).toBe(true)
    expect(isIntentAvailable('edit', 'cloud', true)).toBe(true)
    // And it agrees with the bar for every intent, on every backend/host.
    for (const backend of ['local', 'cloud'] as const) {
      for (const mlxHost of [true, false]) {
        for (const m of INTENTS) {
          expect(isIntentAvailable(m.id, backend, mlxHost), `${m.id}/${backend}/${mlxHost}`)
            .toBe(unlocked(backend, mlxHost).includes(m.id))
        }
      }
    }
  })
})
