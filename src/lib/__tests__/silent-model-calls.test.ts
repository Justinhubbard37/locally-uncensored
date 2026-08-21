/**
 * A7/R5 cost policy for silent model calls.
 *
 * Run: npx vitest run src/lib/__tests__/silent-model-calls.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  silentCallAllowed,
  pickSilentCallModel,
  paramSizeB,
  CHEAP_CLOUD_TEXT_MODELS,
} from '../silent-model-calls'

const cloudModel = (id: string) => ({ name: `lu-cloud::${id}`, type: 'text' })

describe('silentCallAllowed', () => {
  it('blocks lu-cloud while the opt-in is off (the default)', () => {
    expect(silentCallAllowed('lu-cloud', false)).toBe(false)
  })

  it('allows lu-cloud once the user opts in', () => {
    expect(silentCallAllowed('lu-cloud', true)).toBe(true)
  })

  it('never gates a local or BYOK provider, opt-in or not', () => {
    for (const id of ['ollama', 'openai', 'anthropic']) {
      expect(silentCallAllowed(id, false)).toBe(true)
      expect(silentCallAllowed(id, true)).toBe(true)
    }
  })
})

describe('pickSilentCallModel', () => {
  const catalogue = [
    cloudModel('Qwen/Qwen3-Coder-480B-A35B-Instruct'),
    cloudModel('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'),
    cloudModel('deepseek-ai/DeepSeek-V4'),
  ]

  it('leaves a local run on the active model (a second model = a second load)', () => {
    expect(pickSilentCallModel('qwen3:8b', 'ollama', catalogue)).toBe('qwen3:8b')
  })

  it('leaves a BYOK run on the active model', () => {
    expect(
      pickSilentCallModel('anthropic::claude-sonnet-4-20250514', 'anthropic', catalogue),
    ).toBe('anthropic::claude-sonnet-4-20250514')
  })

  it('swaps a cloud flagship for the cheapest catalogue model', () => {
    expect(
      pickSilentCallModel('lu-cloud::Qwen/Qwen3-Coder-480B-A35B-Instruct', 'lu-cloud', catalogue),
    ).toBe('lu-cloud::meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo')
  })

  it('follows the preference order, not the catalogue order', () => {
    const reordered = [
      cloudModel('meta-llama/Llama-3.3-70B-Instruct-Turbo'),
      cloudModel('Sao10K/L3-8B-Lunaris-v1-Turbo'),
      cloudModel('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'),
    ]
    expect(pickSilentCallModel('lu-cloud::whatever', 'lu-cloud', reordered)).toBe(
      'lu-cloud::meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    )
  })

  it('takes the second choice when the first is not served to this account', () => {
    const hostedOnly = [
      cloudModel('Sao10K/L3-8B-Lunaris-v1-Turbo'),
      cloudModel('Qwen/Qwen3-Coder-480B-A35B-Instruct'),
    ]
    expect(pickSilentCallModel('lu-cloud::whatever', 'lu-cloud', hostedOnly)).toBe(
      'lu-cloud::Sao10K/L3-8B-Lunaris-v1-Turbo',
    )
  })

  it('falls back to the smallest model when the catalogue moved on entirely', () => {
    const unknown = [
      cloudModel('vendor/Giant-405B-Instruct'),
      cloudModel('vendor/Small-12B-Instruct'),
      cloudModel('vendor/Middle-70B-Instruct'),
    ]
    expect(pickSilentCallModel('lu-cloud::vendor/Giant-405B-Instruct', 'lu-cloud', unknown)).toBe(
      'lu-cloud::vendor/Small-12B-Instruct',
    )
  })

  it('keeps the active model when nothing recognisable is available', () => {
    expect(pickSilentCallModel('lu-cloud::x/mystery', 'lu-cloud', [cloudModel('x/mystery')])).toBe(
      'lu-cloud::x/mystery',
    )
    expect(pickSilentCallModel('lu-cloud::x/mystery', 'lu-cloud', [])).toBe('lu-cloud::x/mystery')
  })

  it('ignores image and video entries sharing the model list', () => {
    const mixed = [
      { name: 'lu-cloud::some/image-model', type: 'image' },
      cloudModel('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'),
    ]
    expect(pickSilentCallModel('lu-cloud::flagship', 'lu-cloud', mixed)).toBe(
      'lu-cloud::meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    )
  })

  it('never picks a local model for a cloud run', () => {
    const withLocal = [{ name: 'qwen3:0.6b', type: 'text' }, cloudModel('vendor/Small-12B-Instruct')]
    expect(pickSilentCallModel('lu-cloud::flagship', 'lu-cloud', withLocal)).toBe(
      'lu-cloud::vendor/Small-12B-Instruct',
    )
  })
})

describe('paramSizeB', () => {
  it('reads the total size, not the active-parameter suffix', () => {
    expect(paramSizeB('Qwen/Qwen3-30B-A3B')).toBe(30)
    expect(paramSizeB('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo')).toBe(8)
    expect(paramSizeB('openai/gpt-oss-120b')).toBe(120)
    expect(paramSizeB('NousResearch/Hermes-3-Llama-3.1-405B')).toBe(405)
  })

  it('returns null when the id says nothing about size', () => {
    expect(paramSizeB('deepseek-ai/DeepSeek-V4-Flash-0731')).toBeNull()
    expect(paramSizeB('inclusionAI/Ling-3.0-flash')).toBeNull()
  })
})

describe('the preference list itself', () => {
  it('leads with the catalogue entry that is on every plan and cheapest', () => {
    expect(CHEAP_CLOUD_TEXT_MODELS[0]).toBe('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo')
  })

  it('has no duplicates', () => {
    expect(new Set(CHEAP_CLOUD_TEXT_MODELS).size).toBe(CHEAP_CLOUD_TEXT_MODELS.length)
  })
})
