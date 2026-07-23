import { describe, it, expect } from 'vitest'
import { INTENT_MAP, visibleIntents } from '../intents'

// David 2026-07-10: the advanced ops have no local models — they exist only on
// the cloud backend. Only plain generation and removebg (local RMBG node,
// rhodium92/e9aab21) keep a local lane.
describe('intent cloud gating', () => {
  it('edit, animate, upscale and eraser are cloud-only', () => {
    for (const id of ['edit', 'animate', 'upscale', 'eraser'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
    }
  })

  it('image, video and removebg stay available locally', () => {
    for (const id of ['image', 'video', 'removebg'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBeUndefined()
    }
  })

  it('the local (non-Mac) IntentBar filter keeps exactly the local lane', () => {
    const local = visibleIntents('local', false).map((m) => m.id)
    expect(local).toEqual(['image', 'removebg', 'video'])
  })

  it('the local Mac filter drops removebg (no ComfyUI RMBG node there)', () => {
    // MLX-only Mac has no ComfyUI, so RMBG can't run locally — only plain image
    // and video generation remain on the local Mac lane.
    const localMac = visibleIntents('local', true).map((m) => m.id)
    expect(localMac).toEqual(['image', 'video'])
  })

  it('cloud keeps every intent regardless of host', () => {
    const cloud = visibleIntents('cloud', true).map((m) => m.id)
    expect(cloud).toEqual(['image', 'edit', 'removebg', 'upscale', 'eraser', 'video', 'animate'])
  })
})
