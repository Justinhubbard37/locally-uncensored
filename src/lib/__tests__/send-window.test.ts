/**
 * A2: the cost ceiling for one sent step, and the meter that has to be honest
 * about it (2.6.6 plan).
 *
 * Before this, a 262k-context cloud model let a coding step grow to 209k tokens
 * and every step of a long run was billed at that size, while the token counter
 * divided by 262k and sat green at 25 percent. Both halves are tested here: the
 * budget itself, and the denominator the user sees.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  effectiveSendWindow,
  isPaidProvider,
  DEFAULT_SEND_WINDOW_TOKENS,
} from '../send-window'
import { computeContextFill } from '../token-usage'
import { DEFAULT_SETTINGS } from '../constants'

describe('A2: the paid-provider send cap', () => {
  it('gives a 262k cloud model a 64k budget, not 209k', () => {
    const budget = effectiveSendWindow({ providerId: 'lu-cloud', modelWindow: 262144 })
    expect(budget).toBe(DEFAULT_SEND_WINDOW_TOKENS)
  })

  it('negative control: without the cap the same model gets 0.8 of its window', () => {
    const budget = effectiveSendWindow({
      providerId: 'lu-cloud',
      modelWindow: 262144,
      capEnabled: false,
    })
    expect(budget).toBe(Math.floor(262144 * 0.8))
    expect(budget).toBeGreaterThan(200000)
  })

  it('never RAISES a small model to the cap', () => {
    // 32k model: 0.8 x 32768 = 26214, well under 64k, so the cap does nothing.
    expect(effectiveSendWindow({ providerId: 'lu-cloud', modelWindow: 32768 }))
      .toBe(Math.floor(32768 * 0.8))
  })

  it('leaves a local Ollama model exactly where it was', () => {
    for (const window of [8192, 32768, 262144]) {
      expect(effectiveSendWindow({ providerId: 'ollama', modelWindow: window }))
        .toBe(Math.floor(window * 0.8))
    }
  })

  it('applies to every provider that bills, and to no other', () => {
    expect(isPaidProvider('lu-cloud')).toBe(true)
    expect(isPaidProvider('openai')).toBe(true)
    expect(isPaidProvider('anthropic')).toBe(true)
    expect(isPaidProvider('ollama')).toBe(false)
  })

  it('lets a power user raise the ceiling', () => {
    expect(effectiveSendWindow({
      providerId: 'lu-cloud',
      modelWindow: 262144,
      sendWindowTokens: 120000,
    })).toBe(120000)
  })

  it('keeps Small-Model Mode tighter than the cap', () => {
    expect(effectiveSendWindow({
      providerId: 'lu-cloud',
      modelWindow: 262144,
      smallModelMode: true,
    })).toBe(6000)
  })

  it('survives a model whose window is unknown', () => {
    expect(effectiveSendWindow({ providerId: 'lu-cloud', modelWindow: 0 })).toBe(0)
  })
})

describe('A2: the shipped defaults', () => {
  it('ships the cap at 64k and the decay switch on', () => {
    expect(DEFAULT_SETTINGS.codexSendWindowTokens).toBe(64000)
    expect(DEFAULT_SETTINGS.contextDecay).toBe(true)
  })
})

describe('A2 meter honesty: the numerator is what was actually built', () => {
  const msgs = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi', usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22 } },
  ]

  it('uses the built-request size over the usage anchor', () => {
    const fill = computeContextFill(msgs, { tokens: 58000, atMessageCount: 2 })
    expect(fill.source).toBe('built')
    expect(fill.used).toBe(58000)
  })

  it('adds messages that arrived after the request was built', () => {
    const later = [...msgs, { role: 'user', content: 'a'.repeat(400) }]
    const fill = computeContextFill(later, { tokens: 58000, atMessageCount: 2 })
    expect(fill.used).toBeGreaterThan(58000)
    expect(fill.used).toBeLessThan(58200)
  })

  it('falls back to the usage anchor when nothing was built yet', () => {
    expect(computeContextFill(msgs).source).toBe('usage')
  })

  it('ignores a stale report that names more messages than exist', () => {
    const fill = computeContextFill(msgs, { tokens: 58000, atMessageCount: 99 })
    expect(fill.source).toBe('usage')
  })
})

describe('A2: the counter divides by the send window', () => {
  const src = readFileSync(
    resolve(__dirname, '..', '..', 'components', 'chat', 'TokenCounter.tsx'),
    'utf8',
  )

  // There is no render harness in this repo, so the wiring is guarded at the
  // source, the way host-platform.test.ts guards the prompt.
  it('takes its denominator from ctx.sendWindow, not ctx.contextWindow', () => {
    expect(src).toMatch(
      /const window = ctx\.sendWindow > 0 \? ctx\.sendWindow : ctx\.contextWindow/,
    )
    expect(src).toMatch(/const maxTokens = window > 0 \? window : 16384/)
  })

  it('feeds the built-request size in as the numerator', () => {
    expect(src).toMatch(/useSendSizeStore/)
    expect(src).toMatch(/atMessageCount: sent\.atMessageCount/)
  })

  it('explains the cap and the decay in the tooltip', () => {
    expect(src).toMatch(/a step sends at most/)
    expect(src).toMatch(/older than the newest step go out shortened/)
  })
})
