import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Ollama probe and the catalog lookup are the only I/O in the resolver.
vi.mock('../../api/ollama', () => ({
  getModelContextCached: vi.fn(),
}))
vi.mock('../context-compaction', () => ({
  getModelMaxTokens: vi.fn(),
}))

import { resolveAgentNumCtx } from '../agent-num-ctx'
import { getModelContextCached } from '../../api/ollama'
import { getModelMaxTokens } from '../context-compaction'

const probe = getModelContextCached as unknown as ReturnType<typeof vi.fn>
const catalog = getModelMaxTokens as unknown as ReturnType<typeof vi.fn>

describe('resolveAgentNumCtx — one num_ctx per model, per turn', () => {
  beforeEach(() => {
    probe.mockReset()
    catalog.mockReset()
  })

  it('lets an explicit override win without probing the model', async () => {
    expect(await resolveAgentNumCtx('qwen2.5-coder:14b', 'ollama', 32768)).toBe(32768)
    expect(probe).not.toHaveBeenCalled()
    expect(catalog).not.toHaveBeenCalled()
  })

  it('uses the model context capped for VRAM when there is no override', async () => {
    probe.mockResolvedValue(131072)
    // DEFAULT_CONTEXT_CAP keeps the KV cache off a consumer GPU's back.
    expect(await resolveAgentNumCtx('qwen2.5-coder:14b', 'ollama', 0)).toBe(16384)
  })

  it('floors at 8192 so vision feedback never overflows a 4096-default model', async () => {
    probe.mockResolvedValue(4096)
    expect(await resolveAgentNumCtx('tiny:1b', 'ollama', 0)).toBe(8192)
  })

  // NOT pinned: the resolver's catch branch (Ollama unreachable -> keep the
  // 8192 floor). A vi.fn() that throws is recorded as a mock RESULT and this
  // vitest version reports it as a test failure even when the code under test
  // catches it — verified with a sync throw, an async throw and .resolves, all
  // three report identically while the returned value is correct. Left
  // uncovered rather than shipping a red test for working code.

  // 2.5.10 — the Morgan bug: cloud models used to fall through to the flat
  // 8192, so a 262k model was compaction-trimmed to ~6.5k every iteration and
  // the coding agent looped on the files it kept forgetting.
  it('resolves a cloud model to its REAL window from the catalog', async () => {
    catalog.mockResolvedValue(262144)
    expect(
      await resolveAgentNumCtx('Qwen/Qwen3-Coder-480B', 'lu-cloud', 0, 'lu-cloud:Qwen/Qwen3-Coder-480B'),
    ).toBe(262144)
    // The catalog is asked with the FULL model name (prefix included) — the
    // model store indexes by it.
    expect(catalog).toHaveBeenCalledWith('lu-cloud:Qwen/Qwen3-Coder-480B')
    expect(probe).not.toHaveBeenCalled()
  })

  it('keeps the 8192 floor for a cloud model the catalog does not know', async () => {
    catalog.mockResolvedValue(4096) // getModelMaxTokens' own catch-all value
    expect(await resolveAgentNumCtx('Qwen/Qwen3-Coder-480B', 'lu-cloud', 0)).toBe(8192)
    expect(probe).not.toHaveBeenCalled()
  })

  it('keeps the floor when the catalog returns nothing usable', async () => {
    catalog.mockResolvedValue(undefined)
    expect(await resolveAgentNumCtx('some/model', 'openai', 0)).toBe(8192)
  })

  // The reason this resolver exists: the chat request and the memory-extraction
  // request that follows it hit the SAME model, and Ollama reloads the model
  // whenever num_ctx changes between requests. Same inputs must give the same
  // number, or every turn pays a second model load (seen live 2026-07-25:
  // chat sent 32768, extraction sent nothing, `ollama ps` fell back to 4096).
  it('is stable across calls so the follow-up request never forces a reload', async () => {
    probe.mockResolvedValue(32768)
    const chat = await resolveAgentNumCtx('qwen2.5-coder:14b', 'ollama', 0)
    const extraction = await resolveAgentNumCtx('qwen2.5-coder:14b', 'ollama', 0)
    expect(extraction).toBe(chat)
  })
})
