/**
 * G32b (follow-up to G32, 2026-08-07): the workflow engine resolves its tool
 * strategy through agent-strategy.ts, and that copy still had the pre-G26
 * shape: every non-Ollama provider hardcoded to 'native'. providerId 'openai'
 * also covers LM Studio, vLLM and llama.cpp, so a workflow step on a
 * server-declared tool-less local model sent a native `tools` payload.
 *
 * The second half of the finding is the transport: the engine's hermes
 * branches posted to Ollama's /api/chat via chatNonStreaming. Fixing only the
 * strategy would have turned the wrong payload into a 404, because hermes_xml
 * is reachable for LM Studio models now and those are not installed in
 * Ollama. Both hermes paths stream through the provider abstraction instead,
 * and chatNonStreaming lost its last caller and was deleted.
 *
 * Run: npx vitest run src/lib/__tests__/workflow-tool-strategy.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

// tool-capability no-ops silently without localStorage; stub it so the real
// precedence code runs.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => { store.clear() },
})

let models: Array<{ name: string; type: string; supportsTools?: boolean }>
let ollamaCaps: string[]
let getModelCapabilities: ReturnType<typeof vi.fn>
// G37b: what the provider's own live probe answers. null = the provider does
// not implement the method at all (Ollama, Anthropic, stubs).
let serverToolAnswer: boolean | undefined | null
let serverToolSupport: ReturnType<typeof vi.fn>

async function loadResolver() {
  vi.resetModules()
  getModelCapabilities = vi.fn(async () => ollamaCaps)
  serverToolSupport = vi.fn(async () => serverToolAnswer)
  vi.doMock('../../api/providers', () => ({
    getProviderIdFromModel: (n: string) => (n.includes('::') ? n.split('::')[0] : 'ollama'),
    getProviderForModel: (n: string) => ({
      provider: serverToolAnswer === null
        ? { id: 'stub-provider' }
        : { id: 'stub-provider', serverToolSupport },
      modelId: n.includes('::') ? n.split('::').slice(1).join('::') : n,
    }),
  }))
  vi.doMock('../../api/ollama', () => ({ getModelCapabilities }))
  vi.doMock('../../api/model-template-fix', () => ({
    agentVariantExists: vi.fn(async () => false),
    createAgentVariant: vi.fn(),
    getAgentModelName: (m: string) => `${m}-agent`,
    canFixModel: vi.fn(async () => ({ fixable: false })),
  }))
  vi.doMock('../../stores/modelStore', () => ({
    useModelStore: { getState: () => ({ models }) },
  }))
  const mod = await import('../agent-strategy')
  return mod.resolveToolCallingStrategy
}

beforeEach(() => {
  store.clear()
  models = []
  ollamaCaps = []
  serverToolAnswer = null
})

afterEach(() => {
  vi.doUnmock('../../api/providers')
  vi.doUnmock('../../api/ollama')
  vi.doUnmock('../../api/model-template-fix')
  vi.doUnmock('../../stores/modelStore')
  vi.resetModules()
})

describe('the workflow engine gets the same layered resolution as the Agent surface', () => {
  it('G32b core: a server-declared tool-less LM Studio model resolves to the prompt transport', async () => {
    models = [{ name: 'openai::qwen2.5-0.5b-instruct', type: 'text', supportsTools: false }]
    const resolveStrategy = await loadResolver()
    const r = await resolveStrategy('openai::qwen2.5-0.5b-instruct')
    expect(r.strategy).toBe('hermes_xml')
    expect(r.modelToUse).toBe('qwen2.5-0.5b-instruct')
  })

  it('NEGATIVE CONTROL: genuine cloud models stay native', async () => {
    models = [{ name: 'lu-cloud::qwen3-32b', type: 'text', supportsTools: true }]
    const resolveStrategy = await loadResolver()
    expect((await resolveStrategy('anthropic::claude-sonnet-4-20250514')).strategy).toBe('native')
    expect((await resolveStrategy('lu-cloud::qwen3-32b')).strategy).toBe('native')
  })

  it('NEGATIVE CONTROL: /api/show is never probed for a non-Ollama model', async () => {
    // getModelCapabilities speaks Ollama's API; asking it about an LM Studio
    // model would question the wrong server.
    models = [{ name: 'openai::qwen2.5-0.5b-instruct', type: 'text', supportsTools: false }]
    const resolveStrategy = await loadResolver()
    await resolveStrategy('openai::qwen2.5-0.5b-instruct')
    await resolveStrategy('anthropic::claude-sonnet-4-20250514')
    expect(getModelCapabilities).not.toHaveBeenCalled()
  })

  it('G26 parity: Ollama capability overlay downgrades a family-native model without a tool template', async () => {
    ollamaCaps = ['completion', 'thinking']
    const resolveStrategy = await loadResolver()
    expect((await resolveStrategy('qwen3:8b')).strategy).toBe('hermes_xml')
  })

  it('NEGATIVE CONTROL: an Ollama template WITH tools keeps native', async () => {
    ollamaCaps = ['completion', 'tools']
    const resolveStrategy = await loadResolver()
    expect((await resolveStrategy('qwen3:8b')).strategy).toBe('native')
  })
})

describe('G37b: the send-time resolution asks the local server itself', () => {
  // R21d wire proof, 2026-08-08: the managed built-in engine never runs
  // listModels (useModels synthesizes its picker rows from the downloaded
  // GGUFs), so the G37 listing probe never fired and the run still sent a
  // native `tools` payload that llama-server silently drops. The picker row
  // being SILENT is the witness state: models list empty, provider answers.
  it('a server answering false downgrades to the prompt transport even with no picker row', async () => {
    serverToolAnswer = false
    const resolveStrategy = await loadResolver()
    const r = await resolveStrategy('openai::qwen3.5-3b-instruct-gguf')
    expect(r.strategy).toBe('hermes_xml')
    expect(serverToolSupport).toHaveBeenCalledWith('qwen3.5-3b-instruct-gguf')
  })

  it('a server answering true keeps native', async () => {
    serverToolAnswer = true
    const resolveStrategy = await loadResolver()
    expect((await resolveStrategy('openai::qwen3.5-3b-instruct-gguf')).strategy).toBe('native')
  })

  it('NEGATIVE CONTROL: a server that says nothing leaves the plan standing', async () => {
    serverToolAnswer = undefined
    const resolveStrategy = await loadResolver()
    expect((await resolveStrategy('openai::vllm-model')).strategy).toBe('native')
  })

  it('NEGATIVE CONTROL: the probe never fires when the strategy is already hermes', async () => {
    // A picker row that already said false settles it; the extra request
    // would be pure waste.
    serverToolAnswer = false
    models = [{ name: 'openai::tinystories-33m', type: 'text', supportsTools: false }]
    const resolveStrategy = await loadResolver()
    expect((await resolveStrategy('openai::tinystories-33m')).strategy).toBe('hermes_xml')
    expect(serverToolSupport).not.toHaveBeenCalled()
  })

  it('NEGATIVE CONTROL: non-openai providers never consult it', async () => {
    serverToolAnswer = false
    const resolveStrategy = await loadResolver()
    expect((await resolveStrategy('anthropic::claude-sonnet-4-20250514')).strategy).toBe('native')
    expect(serverToolSupport).not.toHaveBeenCalled()
  })
})

describe('the hermes transport goes through the provider, not Ollama', () => {
  const engine = read('../workflow-engine.ts')

  it('no call site posts to Ollama unconditionally anymore', () => {
    // Match the CALL and the import, not the word: the comments explaining
    // this fix are allowed to name the retired function.
    expect(engine).not.toContain('chatNonStreaming(')
    expect(engine).not.toContain("from '../api/agents'")
    expect(engine).toContain('streamProviderTurn(')
  })

  it('the strategy weiche itself is gone from agent-strategy', () => {
    expect(read('../agent-strategy.ts')).not.toContain('isNativeToolProvider(')
  })

  it('chatNonStreaming lost its last caller and is deleted, not stranded', () => {
    expect(existsSync(resolve(here, '../../api/agents.ts'))).toBe(false)
  })
})
