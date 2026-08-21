/**
 * A7: the remembered-context block that rides in EVERY system prompt is capped
 * at ~1k tokens.
 *
 * The budget tiers hand out 2000 tokens at 128k context and 4000 above it, and
 * that block is re-sent on every step of every agent turn. The cap sits in
 * renderRememberedContext, the one place the string is built, so all four
 * injection sites (useChat, useAgentChat, useCodex, the remote dispatcher)
 * inherit it. Under the cap nothing changes: a small memory set is still
 * injected whole.
 *
 * NEGATIVE CONTROL (verified by hand): drop the `Math.min(budgetTokens,
 * MEMORY_CONTEXT_TOKEN_CAP)` line in memoryStore.ts and "caps a big memory set"
 * goes red at ~8000 chars.
 *
 * Run: npx vitest run src/stores/__tests__/memory-context-cap.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useMemoryStore, MEMORY_CONTEXT_TOKEN_CAP } from '../memoryStore'

// The tier for a 128k model: 2000 tokens, 15 memories — double the cap.
const BIG_CONTEXT = 131072
const CAP_CHARS = MEMORY_CONTEXT_TOKEN_CAP * 4

function seed(count: number, contentLength: number) {
  const store = useMemoryStore.getState()
  store.clearAll()
  for (let i = 0; i < count; i++) {
    store.addMemory({
      type: 'user',
      title: `Fact ${i} about deployment`,
      description: 'deployment note',
      content: `deployment ${i} ${'detail '.repeat(Math.ceil(contentLength / 7)).slice(0, contentLength)}`,
      tags: ['deployment'],
    } as never)
  }
}

beforeEach(() => {
  useMemoryStore.getState().clearAll()
})

describe('memory context cap', () => {
  it('caps a big memory set at the 1k-token ceiling', () => {
    // 15 entries x ~400 injected chars is ~6000 chars, well past the cap and
    // inside the tier's own 8000-char budget, so only the cap can trim it.
    seed(15, 400)
    const block = useMemoryStore.getState().getMemoriesForPrompt('deployment', BIG_CONTEXT)

    expect(block).not.toBe('')
    expect(block.length).toBeLessThanOrEqual(CAP_CHARS + 64) // + the wrapper tags
  })

  it('leaves a small set fully injected', () => {
    seed(3, 60)
    const block = useMemoryStore.getState().getMemoriesForPrompt('deployment', BIG_CONTEXT)

    for (let i = 0; i < 3; i++) {
      expect(block).toContain(`Fact ${i} about deployment`)
    }
    expect(block.length).toBeLessThan(CAP_CHARS)
  })

  it('never raises a tier that already budgets less than the cap', () => {
    // The 8k tier budgets 800 tokens; the cap must not become a floor.
    seed(8, 400)
    const small = useMemoryStore.getState().getMemoriesForPrompt('deployment', 8192)
    expect(small.length).toBeLessThanOrEqual(800 * 4 + 64)
  })

  it('applies on the async (embedding-blended) path too', async () => {
    seed(15, 400)
    const block = await useMemoryStore
      .getState()
      .getMemoriesForPromptAsync('deployment', BIG_CONTEXT)

    expect(block.length).toBeLessThanOrEqual(CAP_CHARS + 64)
  })
})
