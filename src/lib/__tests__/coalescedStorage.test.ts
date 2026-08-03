import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StateStorage } from 'zustand/middleware'
import { coalescedJSONStorage } from '../coalescedStorage'

// A base StateStorage that records every write and can be made slow, so a test
// can prove that writes arriving DURING a write collapse into one follow-up
// instead of queueing (the renderer OOM this module exists to prevent).
function mockBase(writeMs = 0) {
  const writes: string[] = []
  let store: Record<string, string> = {}
  const base: StateStorage = {
    getItem: vi.fn((k: string) => store[k] ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      if (writeMs) await new Promise((r) => setTimeout(r, writeMs))
      store[k] = v
      writes.push(v)
    }),
    removeItem: vi.fn(async (k: string) => { delete store[k] }),
  }
  return { base, writes, peek: (k: string) => store[k] ?? null, reset: () => { store = {} } }
}

const val = (n: number) => ({ state: { conversations: [{ id: String(n) }] }, version: 0 })

describe('coalescedJSONStorage', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('collapses a burst of writes into ONE, carrying the newest state', async () => {
    const { base, writes } = mockBase()
    const s = coalescedJSONStorage(base, { waitMs: 1000, maxWaitMs: 5000 })

    // 1800 flushes is what a 30 s answer produced at one per animation frame.
    for (let i = 0; i < 1800; i++) s.setItem('chat', val(i) as never)
    expect(base.setItem).not.toHaveBeenCalled() // nothing serialised yet

    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]).state.conversations[0].id).toBe('1799')
  })

  it('serialises once per window, not once per set()', async () => {
    // The actual OOM mechanism: JSON.stringify ran on every set(), each run
    // minting another multi-MB string. Count the reads the serialiser makes.
    const { base } = mockBase()
    const s = coalescedJSONStorage(base, { waitMs: 1000 })
    let serialised = 0
    const probe = {
      state: { get conversations() { serialised++; return [] } },
      version: 0,
    }

    for (let i = 0; i < 1800; i++) s.setItem('chat', probe as never)
    expect(serialised).toBe(0)

    await vi.advanceTimersByTimeAsync(1000)
    expect(serialised).toBe(1)
  })

  it('checkpoints at maxWaitMs even while changes keep arriving', async () => {
    const { base, writes } = mockBase()
    const s = coalescedJSONStorage(base, { waitMs: 1000, maxWaitMs: 3000 })

    // A change every 100 ms would reset a plain trailing debounce forever.
    for (let i = 0; i < 50; i++) {
      s.setItem('chat', val(i) as never)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(writes.length).toBeGreaterThanOrEqual(1)
    expect(writes.length).toBeLessThan(5) // not one per change
  })

  it('keeps at most one write in flight and folds the rest into a single follow-up', async () => {
    const { base, writes } = mockBase(200) // a slow, multi-MB-sized put
    const s = coalescedJSONStorage(base, { waitMs: 10, maxWaitMs: 50 })

    s.setItem('chat', val(0) as never)
    await vi.advanceTimersByTimeAsync(10) // write starts, takes 200 ms

    // 100 more changes land while that write is still running.
    for (let i = 1; i <= 100; i++) s.setItem('chat', val(i) as never)
    await vi.advanceTimersByTimeAsync(1000)

    expect(writes).toHaveLength(2) // the in-flight one + ONE catch-up
    expect(JSON.parse(writes[1]).state.conversations[0].id).toBe('100')
  })

  it('flush() writes the pending state immediately', async () => {
    const { base, writes, peek } = mockBase()
    const s = coalescedJSONStorage(base, { waitMs: 60_000 })

    s.setItem('chat', val(7) as never)
    expect(writes).toHaveLength(0)

    await s.flush()
    expect(writes).toHaveLength(1)
    expect(JSON.parse(peek('chat')!).state.conversations[0].id).toBe('7')
  })

  it('flush() on an idle storage resolves without writing', async () => {
    const { base } = mockBase()
    const s = coalescedJSONStorage(base, { waitMs: 1000 })
    await s.flush()
    expect(base.setItem).not.toHaveBeenCalled()
  })

  it('removeItem cancels a queued write so it cannot resurrect the data', async () => {
    const { base, peek } = mockBase()
    const s = coalescedJSONStorage(base, { waitMs: 1000 })

    s.setItem('chat', val(1) as never)
    await s.removeItem('chat')
    await vi.advanceTimersByTimeAsync(5000)

    expect(base.setItem).not.toHaveBeenCalled()
    expect(peek('chat')).toBeNull()
  })

  it('reads back what it wrote', async () => {
    const { base } = mockBase()
    const s = coalescedJSONStorage(base, { waitMs: 10 })
    s.setItem('chat', val(3) as never)
    await vi.advanceTimersByTimeAsync(10)
    expect((s.getItem('chat') as { state: { conversations: { id: string }[] } }).state.conversations[0].id).toBe('3')
  })

  it('stays SYNCHRONOUS when the base storage is synchronous', () => {
    // Keeps zustand hydration synchronous in the node test env, which the
    // existing store suite depends on.
    const { base } = mockBase()
    base.setItem('chat', JSON.stringify(val(1)))
    const s = coalescedJSONStorage(base, { waitMs: 10 })
    expect(s.getItem('chat')).not.toBeInstanceOf(Promise)
  })

  it('awaits an async base read', async () => {
    const raw = JSON.stringify(val(9))
    const base: StateStorage = {
      getItem: async () => raw,
      setItem: async () => {},
      removeItem: async () => {},
    }
    const s = coalescedJSONStorage<{ conversations: { id: string }[] }>(base)
    const got = s.getItem('chat')
    expect(got).toBeInstanceOf(Promise)
    const resolved = await got
    expect(resolved!.state.conversations[0].id).toBe('9')
  })

  it('returns null instead of throwing on a corrupt payload', () => {
    const base: StateStorage = {
      getItem: () => '{not json',
      setItem: async () => {},
      removeItem: async () => {},
    }
    const s = coalescedJSONStorage(base)
    expect(s.getItem('chat')).toBeNull()
  })

  it('returns null for a missing key', () => {
    const { base } = mockBase()
    const s = coalescedJSONStorage(base)
    expect(s.getItem('nope')).toBeNull()
  })

  it('survives a failing write and still writes the next change', async () => {
    let fail = true
    const writes: string[] = []
    const base: StateStorage = {
      getItem: () => null,
      setItem: async (_k, v) => {
        if (fail) { fail = false; throw new Error('idb full') }
        writes.push(v)
      },
      removeItem: async () => {},
    }
    const s = coalescedJSONStorage(base, { waitMs: 10 })

    s.setItem('chat', val(1) as never)
    await vi.advanceTimersByTimeAsync(10)
    expect(writes).toHaveLength(0) // first one threw

    s.setItem('chat', val(2) as never)
    await vi.advanceTimersByTimeAsync(10)
    expect(writes).toHaveLength(1) // storage is not wedged
    expect(JSON.parse(writes[0]).state.conversations[0].id).toBe('2')
  })
})
