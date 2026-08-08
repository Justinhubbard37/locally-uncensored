import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Regression guard for the renderer Out of Memory (Morgan, 2026-08-03).
//
// The chat store persists through zustand's `persist`, which writes on EVERY
// set() with no debounce. useChat flushes the streaming bubble once per
// animation frame, so a 30 s answer used to serialise the entire chat history
// ~1800 times and hand IndexedDB ~1800 multi-MB strings that could not be
// collected while their writes were outstanding. Measured on a normal profile:
// 8.1 GB of churn, 5.1 GB held live, per answer.
//
// This asserts the fix at the store level, not at the helper level: the real
// store, driven the way the streaming loop drives it.

const writes: string[] = []
vi.mock('../../lib/idbStorage', () => ({
  idbStorage: {
    getItem: () => null,
    setItem: (_k: string, v: string) => { writes.push(v); return Promise.resolve() },
    removeItem: () => Promise.resolve(),
  },
}))

const FLUSHES = 1800 // 30 s answer at one flush per animation frame

describe('chatStore persist coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    writes.length = 0
  })
  afterEach(() => { vi.useRealTimers() })

  it('a full streaming answer costs a handful of writes, not one per frame', async () => {
    const { useChatStore } = await import('../chatStore')
    const convId = useChatStore.getState().createConversation('m', '')
    useChatStore.getState().addMessage(convId, {
      id: 'a1', role: 'assistant', content: '', timestamp: 1,
    })
    await vi.advanceTimersByTimeAsync(10_000)
    writes.length = 0

    // The streaming loop: content grows by a token, store gets the whole string.
    let content = ''
    for (let i = 0; i < FLUSHES; i++) {
      content += 'token '
      useChatStore.getState().updateMessageContent(convId, 'a1', content)
      await vi.advanceTimersByTimeAsync(16) // one animation frame
    }
    await vi.advanceTimersByTimeAsync(10_000) // let the trailing write land

    // maxWaitMs is 2 s and the answer runs ~29 s of fake time, so the store
    // checkpoints ~15 times and writes once more on the trailing edge. The old
    // behaviour was one write per frame: 1800.
    expect(writes.length).toBeLessThanOrEqual(20)
    expect(writes.length).toBeGreaterThan(0)

    // Nothing was lost: the last write carries the complete answer.
    const last = JSON.parse(writes[writes.length - 1])
    const conv = last.state.conversations.find((c: { id: string }) => c.id === convId)
    expect(conv.messages[0].content).toBe(content)
  })

  it('serialises megabytes once per window, not once per message update', async () => {
    const { useChatStore } = await import('../chatStore')
    const convId = useChatStore.getState().createConversation('m', '')
    // An image in the history is what makes each serialisation expensive.
    useChatStore.getState().addMessage(convId, {
      id: 'u1', role: 'user', content: 'look at this', timestamp: 1,
      images: [{ data: 'A'.repeat(200_000), mimeType: 'image/png', name: 'shot.png' }],
    })
    useChatStore.getState().addMessage(convId, {
      id: 'a2', role: 'assistant', content: '', timestamp: 2,
    })
    await vi.advanceTimersByTimeAsync(10_000)
    writes.length = 0

    for (let i = 0; i < 300; i++) {
      useChatStore.getState().updateMessageContent(convId, 'a2', 'x'.repeat(i))
      await vi.advanceTimersByTimeAsync(16)
    }
    await vi.advanceTimersByTimeAsync(10_000)

    const bytes = writes.reduce((n, w) => n + w.length, 0)
    // 300 frames × ~200 KB of base64 would be ~60 MB of string churn. The
    // window collapses it to a couple of checkpoints.
    expect(bytes).toBeLessThan(5_000_000)
  })
})
