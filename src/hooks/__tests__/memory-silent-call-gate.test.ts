/**
 * A7: the auto-memory extraction is a PAID call on lu-cloud, so it only fires
 * with the explicit opt-in, and then on the cheapest catalogue model instead of
 * the active one.
 *
 * These run the real `extractMemoriesFromPair` with mocked stores/providers, so
 * the assertion is "did a request leave the app", not "does the source contain
 * a guard". The gate sits inside the extraction function, one level below every
 * caller (useChat, useCodex, the remote listener), which is what makes it
 * inheritable — a new call site cannot forget it.
 *
 * NEGATIVE CONTROL (verified by hand, documented so the next reader can redo
 * it): drop the `if (!call) return` in useMemory.ts's extractMemoriesFromPair,
 * or make silentCallAllowed return true unconditionally, and
 * "fires no request on lu-cloud without the opt-in" goes red.
 *
 * Run: npx vitest run src/hooks/__tests__/memory-silent-call-gate.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Mocked module graph ────────────────────────────────────────
// Everything the extraction touches, kept dumb so the only interesting
// question is whether chatStream was reached and with which model.

const chatStream = vi.fn()
const addMemory = vi.fn(() => 'mem-1')

let activeModel = 'qwen3:8b'
let models: Array<{ name: string; type: string }> = []
let memoryCloudOptIn = false
let memorySettings = { autoExtractEnabled: true, autoExtractInAllModes: false }

vi.mock('../../stores/modelStore', () => ({
  useModelStore: { getState: () => ({ activeModel, models }) },
}))

vi.mock('../../stores/memoryStore', () => ({
  useMemoryStore: {
    getState: () => ({
      settings: memorySettings,
      entries: [],
      addMemory,
      removeMemory: vi.fn(),
      applyWriteDecision: vi.fn(),
    }),
  },
}))

vi.mock('../../stores/providerStore', () => ({
  useProviderStore: {
    getState: () => ({
      providers: {
        openai: { enabled: true, isLocal: true },
        anthropic: { enabled: false },
      },
    }),
  },
}))

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ settings: { memoryCloudOptIn, contextWindowOverride: 0 } }),
  },
}))

vi.mock('../../api/providers', () => ({
  getProviderForModel: (name: string) => ({
    provider: { chatStream },
    modelId: name.includes('::') ? name.split('::')[1] : name,
  }),
  getProviderIdFromModel: (name: string) =>
    name.includes('::') ? name.split('::')[0] : 'ollama',
}))

vi.mock('../../lib/agent-num-ctx', () => ({
  resolveAgentNumCtx: vi.fn(async () => 8192),
}))

vi.mock('../../api/rag', () => ({
  generateEmbeddings: vi.fn(async () => [[]]),
  cosineSimilarity: vi.fn(() => 0),
}))

vi.mock('../../lib/memoryEmbedDB', () => ({
  loadVectors: vi.fn(async () => new Map()),
}))

const { extractMemoriesFromPair } = await import('../useMemory')

// The extraction is rate-limited to every 3rd turn (module counter). Three
// consecutive calls therefore contain EXACTLY one attempt, whatever the
// counter's starting value — so each scenario drives three turns.
const RATE_LIMIT = 3
const LONG_REPLY = 'x'.repeat(200)

async function threeTurns() {
  for (let i = 0; i < RATE_LIMIT; i++) {
    await extractMemoriesFromPair('what do I do for work?', LONG_REPLY, 'conv-1')
  }
}

/** One empty stream, so the extraction completes without parsing anything. */
function emptyStream() {
  return (async function* () {
    yield { content: '', done: true }
  })()
}

beforeEach(() => {
  chatStream.mockReset()
  chatStream.mockImplementation(() => emptyStream())
  addMemory.mockClear()
  memorySettings = { autoExtractEnabled: true, autoExtractInAllModes: false }
  models = [
    { name: 'lu-cloud::Qwen/Qwen3-Coder-480B-A35B-Instruct', type: 'text' },
    { name: 'lu-cloud::meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', type: 'text' },
    { name: 'qwen3:8b', type: 'text' },
  ]
})

describe('lu-cloud', () => {
  it('fires no request without the opt-in (the shipped default)', async () => {
    activeModel = 'lu-cloud::Qwen/Qwen3-Coder-480B-A35B-Instruct'
    memoryCloudOptIn = false

    await threeTurns()

    expect(chatStream).not.toHaveBeenCalled()
  })

  it('fires on the cheapest catalogue model once the user opts in', async () => {
    activeModel = 'lu-cloud::Qwen/Qwen3-Coder-480B-A35B-Instruct'
    memoryCloudOptIn = true

    await threeTurns()

    expect(chatStream).toHaveBeenCalledTimes(1)
    expect(chatStream.mock.calls[0][0]).toBe('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo')
    // and never the flagship the visible chat is running on
    expect(chatStream.mock.calls[0][0]).not.toContain('480B')
  })
})

describe('local and BYOK stay ungated', () => {
  it('a local model extracts with the opt-in off', async () => {
    activeModel = 'qwen3:8b'
    memoryCloudOptIn = false

    await threeTurns()

    expect(chatStream).toHaveBeenCalledTimes(1)
    expect(chatStream.mock.calls[0][0]).toBe('qwen3:8b')
  })

  it('a BYOK Anthropic model extracts on the active model, opt-in off', async () => {
    activeModel = 'anthropic::claude-sonnet-4-20250514'
    memoryCloudOptIn = false
    // BYOK keeps its own switch (memory settings), which the audit left alone.
    memorySettings = { autoExtractEnabled: true, autoExtractInAllModes: true }

    await threeTurns()

    expect(chatStream).toHaveBeenCalledTimes(1)
    expect(chatStream.mock.calls[0][0]).toBe('claude-sonnet-4-20250514')
  })
})

describe('the existing guards still hold', () => {
  it('extracts nothing when auto-extract is switched off', async () => {
    activeModel = 'qwen3:8b'
    memoryCloudOptIn = true
    memorySettings = { autoExtractEnabled: false, autoExtractInAllModes: true }

    await threeTurns()

    expect(chatStream).not.toHaveBeenCalled()
  })

  it('skips a reply too short to hold a fact', async () => {
    activeModel = 'qwen3:8b'
    memoryCloudOptIn = true

    for (let i = 0; i < RATE_LIMIT; i++) {
      await extractMemoriesFromPair('hi', 'ok', 'conv-1')
    }

    expect(chatStream).not.toHaveBeenCalled()
  })
})
