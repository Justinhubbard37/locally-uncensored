import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isOrphanRun } from '../orphan-run'
import { useGenerationStore } from '../../stores/generationStore'

describe('G29: a run that outlived the view that started it', () => {
  beforeEach(() => {
    useGenerationStore.setState({ generating: {}, aborters: {} })
  })

  it('is orphaned when the conversation is generating but no local run accounts for it', () => {
    // The remounted hook: useState(false) twice, store flag still set by the
    // run that is still going inside the unmounted instance's closure.
    expect(isOrphanRun(true, false, false)).toBe(true)
  })

  // ── Negative controls ────────────────────────────────────────────────────
  //
  // Each of these would show a Stop button on a chat that has nothing to stop,
  // and would block the composer for a user who is free to type.

  it('a plain chat run this instance owns is not orphaned', () => {
    expect(isOrphanRun(true, true, false)).toBe(false)
  })

  it('an agent run this instance owns is not orphaned', () => {
    expect(isOrphanRun(true, false, true)).toBe(false)
  })

  it('an idle conversation is not orphaned', () => {
    expect(isOrphanRun(false, false, false)).toBe(false)
  })

  it('a run in ANOTHER conversation does not orphan the one on screen', () => {
    // storeGenerating is read for the ACTIVE conversation, so a turn in flight
    // elsewhere reads false here even though the hook's global flag is true.
    expect(isOrphanRun(false, true, false)).toBe(false)
  })

  it('the way back works: Stop reaches the old run through the store', () => {
    const abortTheOldRun = vi.fn()
    // What sendAgentMessage registered before the view unmounted.
    useGenerationStore.getState().setGenerating('conv-1', true)
    useGenerationStore.getState().registerAborter('conv-1', abortTheOldRun)

    expect(isOrphanRun(!!useGenerationStore.getState().generating['conv-1'], false, false)).toBe(true)

    useGenerationStore.getState().abortConversation('conv-1')

    expect(abortTheOldRun).toHaveBeenCalledTimes(1)
    expect(useGenerationStore.getState().generating['conv-1']).toBeUndefined()
    expect(useGenerationStore.getState().aborters['conv-1']).toBeUndefined()
  })

  it('Stop still clears the flag when the run left no aborter behind', () => {
    useGenerationStore.getState().setGenerating('conv-2', true)
    useGenerationStore.getState().abortConversation('conv-2')
    expect(useGenerationStore.getState().generating['conv-2']).toBeUndefined()
  })
})
