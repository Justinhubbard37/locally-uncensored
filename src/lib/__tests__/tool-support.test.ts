import { describe, it, expect, beforeEach, vi } from 'vitest'

// vitest runs on `node`, which has no localStorage — and tool-capability
// silently no-ops without it, so the cache half of the precedence would never
// be exercised. Stub it before importing anything that reads it.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => { store.clear() },
})

// Drive the reactive cache through its real API so the precedence under test
// is the one the app runs.
import { markToolsUnsupported, resetToolCapabilityCache } from '../../api/tool-capability'
import { resolveToolSupport, canUseTools, toolStrategyFor } from '../tool-support'

beforeEach(() => {
  store.clear()
  resetToolCapabilityCache()
})

describe('resolveToolSupport — one precedence for every surface', () => {
  it('a plain hosted model does native tool calling', () => {
    expect(resolveToolSupport({ name: 'lu-cloud::qwen3-32b' })).toBe('native')
  })

  it('a hosted model the server declares tool-less is out entirely', () => {
    // LU Cloud sets supports_tools:false on its story/roleplay models. Offering
    // them in Code meant a paid round-trip that always ended in a 405.
    expect(resolveToolSupport({ name: 'lu-cloud::mythomax-13b', supportsTools: false })).toBe('none')
    expect(canUseTools({ name: 'lu-cloud::mythomax-13b', supportsTools: false })).toBe(false)
  })

  it('a hosted model PROVEN to reject tools is out even without the flag', () => {
    markToolsUnsupported('lu-cloud::euryale-70b')
    expect(resolveToolSupport({ name: 'lu-cloud::euryale-70b' })).toBe('none')
  })

  // Ollama models are stored BARE (no `provider::` prefix) — that is what
  // getProviderIdFromModel falls back to, so these names are the real ones.
  it('a LOCAL model that rejects native tools falls back to the XML path', () => {
    // Prompt-injected <tool_call> is pure prompting, so a local model that
    // refused a `tools` payload can still drive the agent. This is how small
    // Ollama models have worked since 2.5.3 and must not regress.
    markToolsUnsupported('llama3.2:1b')
    expect(resolveToolSupport({ name: 'llama3.2:1b' })).toBe('hermes')
    expect(canUseTools({ name: 'llama3.2:1b' })).toBe(true)
  })

  it('an Ollama model off the agent-compatible list uses the XML path', () => {
    expect(resolveToolSupport({ name: 'mythomax:13b' })).toBe('hermes')
  })

  it('an Ollama model on the list does native', () => {
    expect(resolveToolSupport({ name: 'qwen3:8b' })).toBe('native')
  })

  it('an empty name is not tool-capable', () => {
    expect(resolveToolSupport({ name: '' })).toBe('none')
    expect(canUseTools({ name: '' })).toBe(false)
  })

  it('supportsTools true does not override a proven rejection for cloud', () => {
    // The cache is evidence from a real run; the flag is a claim. Evidence wins.
    markToolsUnsupported('lu-cloud::some-model')
    expect(resolveToolSupport({ name: 'lu-cloud::some-model', supportsTools: true })).toBe('none')
  })
})

describe('toolStrategyFor — the run gets the shape the UI promised', () => {
  it('sends native for a capable hosted model', () => {
    expect(toolStrategyFor({ name: 'lu-cloud::qwen3-32b' })).toBe('native')
  })

  it('never sends native for a model that already rejected it', () => {
    // The exact useCodex bug: non-Ollama providers were hardcoded to 'native',
    // so a declared-tool-less model got a `tools` payload every single run.
    markToolsUnsupported('openai::local-model')
    expect(toolStrategyFor({ name: 'openai::local-model' })).toBe('hermes_xml')
  })

  it('keeps the XML path for an off-list Ollama model', () => {
    expect(toolStrategyFor({ name: 'ollama::mythomax:13b' })).toBe('hermes_xml')
  })
})
