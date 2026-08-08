/**
 * The Agent toggle said no to a model the Coding surface was already driving.
 *
 * Measured on the installed 2.6.2 Windows build, 2026-08-06, while setting up
 * matrix row R18. Model hf.co/DevQuasar/huihui-ai.Qwen3-4B-abliterated-GGUF,
 * which Ollama reports as `capabilities: ['completion']`, so `supportsTools`
 * arrives as false. On the Coding surface that model had just run 51 tool
 * steps through the hermes transport. On the Chat surface the Agent button was
 * greyed out with the tooltip "This model is not agent-compatible".
 *
 * Cause: the toggle re-derived tool capability instead of asking. Its middle
 * rule was `serverTools !== undefined ? serverTools`, so a declared false
 * disabled Agent outright. `resolveToolSupport` maps that same input to
 * 'hermes' for a LOCAL model and only to 'none' for a CLOUD one, because the
 * cloud proxy already does the prompt translation server side and a false
 * there means the model genuinely cannot be driven.
 *
 * This is the second copy of the same stale two-state assumption. The picker
 * badge was fixed earlier the same day; nobody brought the toggle along. Hence
 * the structural assertion at the bottom: the toggle must ASK, not re-derive.
 *
 * Run: npx vitest run src/components/chat/__tests__/agent-toggle-matches-the-run.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

vi.mock('../../../api/tool-capability', () => ({ getToolCapability: () => 'unknown' }))
vi.mock('../../../stores/providerStore', () => ({
  useProviderStore: { getState: () => ({ providers: { openai: { isLocal: true } } }) },
}))

const { canUseTools, resolveToolSupport } = await import('../../../lib/tool-support')

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../AgentModeToggle.tsx'),
  'utf8',
)

const R18_MODEL = 'hf.co/DevQuasar/huihui-ai.Qwen3-4B-abliterated-GGUF:Q4_K_M'

describe('the model from the R18 row', () => {
  it('is driven through hermes, not refused', () => {
    expect(resolveToolSupport({ name: R18_MODEL, supportsTools: false })).toBe('hermes')
  })

  it('so the Agent toggle has to be enabled for it', () => {
    expect(canUseTools({ name: R18_MODEL, supportsTools: false })).toBe(true)
  })

  it('and the Coding surface agrees, which was the whole contradiction', () => {
    // Both surfaces now read the same function, so there is nothing left to
    // disagree about. Asserted as an equality rather than two booleans so a
    // future edit that splits them again fails here.
    const coding = resolveToolSupport({ name: R18_MODEL, supportsTools: false }) !== 'none'
    const agent = canUseTools({ name: R18_MODEL, supportsTools: false })
    expect(agent).toBe(coding)
  })
})

describe('what must NOT change', () => {
  it('NEGATIVE CONTROL: a cloud model declaring no tools stays disabled', () => {
    // This is the reason the serverTools rule existed. Losing it would hand
    // the user a mid-run 400 on the cloud models without function calling.
    expect(canUseTools({ name: 'lu-cloud::some-model', supportsTools: false })).toBe(false)
  })

  it('a proven rejection disables a CLOUD model, and only a cloud one', async () => {
    vi.resetModules()
    vi.doMock('../../../api/tool-capability', () => ({ getToolCapability: () => 'unsupported' }))
    vi.doMock('../../../stores/providerStore', () => ({
      useProviderStore: { getState: () => ({ providers: { openai: { isLocal: true } } }) },
    }))
    const fresh = await import('../../../lib/tool-support')
    expect(fresh.canUseTools({ name: 'lu-cloud::some-model', supportsTools: true })).toBe(false)
    // Locally a proven rejection only means "no NATIVE tools". The XML path is
    // pure prompting and is exactly what it falls back to, which is also why
    // the toggle must no longer treat that verdict as a hard no.
    expect(fresh.resolveToolSupport({ name: R18_MODEL, supportsTools: true })).toBe('hermes')
    expect(fresh.canUseTools({ name: R18_MODEL, supportsTools: true })).toBe(true)
  })

  it('a declared-capable local model is of course still fine', () => {
    expect(canUseTools({ name: 'qwen2.5-coder:14b', supportsTools: true })).toBe(true)
  })
})

describe('the toggle asks instead of re-deriving', () => {
  it('it calls canUseTools with the model and the server answer', () => {
    expect(src).toMatch(/canUseTools\(\{\s*name: activeModel,\s*supportsTools: serverTools\s*\}\)/)
  })

  it('the hand-rolled precedence chain is gone', () => {
    expect(src).not.toMatch(/serverTools !== undefined \? serverTools/)
    expect(src).not.toMatch(/isAgentCompatible\(activeModel\)/)
  })

  it('and it no longer imports the pieces it used to re-derive from', () => {
    expect(src).not.toMatch(/import \{ isAgentCompatible \}/)
    expect(src).not.toMatch(/import \{ getToolCapability \}/)
  })
})
