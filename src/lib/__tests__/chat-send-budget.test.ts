/**
 * A4, the budget half: the three conversation surfaces stop sending the whole
 * history to a paid provider.
 *
 * Plain chat, a group round (per model) and compare (both sides) all resolve
 * their payload through this module, so the numbers below are the numbers that
 * go over the wire. Every claim has its negative control: the cap is one
 * setting away from off, and a local backend has to come out byte-identical to
 * 2.6.5 or the whole thing is a regression for everyone who does not pay per
 * token.
 */

import { describe, it, expect } from 'vitest'
import {
  applyChatSendBudget,
  applySendBudget,
  chatSendBudget,
  sharedChatSendBudget,
} from '../chat-send-budget'
import { estimateMessageTokens, MAX_SEND_MESSAGES } from '../context-compaction'
import { DEFAULT_SEND_WINDOW_TOKENS } from '../send-window'

interface Wire {
  role: string
  content: string
  images?: { data: string; mimeType: string }[]
}

const size = (msgs: Wire[]) => estimateMessageTokens(msgs as never)

/** A history of roughly `tokens` tokens, in ordinary chat-sized turns. */
function historyOf(tokens: number): Wire[] {
  const perMessage = 500
  const chars = 'x '.repeat(perMessage) // ~1000 chars, ~250 tokens
  const out: Wire[] = [{ role: 'system', content: 'be helpful' }]
  while (size(out) < tokens) {
    out.push({ role: 'user', content: `q${out.length} ${chars}` })
    out.push({ role: 'assistant', content: `a${out.length} ${chars}` })
  }
  return out
}

const CLOUD_32K = { providerId: 'lu-cloud', modelWindow: 32768, contextDecay: true }
const CLOUD_262K = { providerId: 'lu-cloud', modelWindow: 262144, contextDecay: true }
const OLLAMA = { providerId: 'ollama', modelWindow: 262144, contextDecay: true }

describe('A4: a long chat costs budget level, not history level', () => {
  it('a 50k-token history plus a short question sends at most the budget', () => {
    const history = historyOf(50000)
    history.push({ role: 'user', content: 'and shorter please' })
    expect(size(history)).toBeGreaterThan(50000)

    const budget = chatSendBudget(CLOUD_32K)!
    expect(budget).toBe(Math.floor(32768 * 0.8))
    const sent = applyChatSendBudget(history, CLOUD_32K)
    expect(sent.promptTokens).toBeLessThanOrEqual(budget)
    expect(size(sent.messages)).toBeLessThanOrEqual(budget)
  })

  it('negative control: without the cap the same turn sends the whole 50k', () => {
    const history = historyOf(50000)
    history.push({ role: 'user', content: 'and shorter please' })
    const sent = applyChatSendBudget(history, { ...CLOUD_32K, contextDecay: false })
    expect(sent.budget).toBeNull()
    expect(sent.promptTokens).toBeGreaterThan(50000)
    expect(sent.messages).toBe(history)
  })

  it('a 262k model is capped at the 64k send window, not at 209k', () => {
    const history = historyOf(120000)
    expect(chatSendBudget(CLOUD_262K)).toBe(DEFAULT_SEND_WINDOW_TOKENS)
    const sent = applyChatSendBudget(history, CLOUD_262K)
    expect(sent.promptTokens).toBeLessThanOrEqual(DEFAULT_SEND_WINDOW_TOKENS)
  })

  it('negative control: the same history uncapped is over 100k', () => {
    const history = historyOf(120000)
    const sent = applyChatSendBudget(history, { ...CLOUD_262K, contextDecay: false })
    expect(sent.promptTokens).toBeGreaterThan(100000)
  })

  it('the power-user setting still raises it', () => {
    expect(chatSendBudget({ ...CLOUD_262K, sendWindowTokens: 128000 })).toBe(128000)
  })

  it('keeps the last messages, so the question being asked is always sent', () => {
    const history = historyOf(50000)
    history.push({ role: 'user', content: 'and shorter please' })
    const sent = applyChatSendBudget(history, CLOUD_32K)
    expect(sent.messages[sent.messages.length - 1].content).toBe('and shorter please')
    expect(sent.messages[0].role).toBe('system')
  })
})

describe('A4: a local backend is byte-identical to 2.6.5', () => {
  it('hands the very same array through, unchanged', () => {
    const history = historyOf(120000)
    history.push({
      role: 'user',
      content: 'look',
      images: [{ data: 'A'.repeat(40000), mimeType: 'image/png' }],
    })
    const before = JSON.stringify(history)
    const sent = applyChatSendBudget(history, OLLAMA)
    expect(sent.budget).toBeNull()
    expect(sent.messages).toBe(history)
    expect(JSON.stringify(sent.messages)).toBe(before)
    expect(sent.droppedImages).toBe(0)
  })

  it('negative control: the same history on lu-cloud does shrink', () => {
    const history = historyOf(120000)
    expect(applyChatSendBudget(history, CLOUD_262K).messages.length).toBeLessThan(history.length)
  })

  it('an unknown window resolves to no cap rather than to a tiny one', () => {
    expect(chatSendBudget({ providerId: 'lu-cloud', modelWindow: 0, contextDecay: true })).toBeNull()
  })
})

describe('A4: a group round is budgeted per model per round', () => {
  it('every model in the line-up gets the same ceiling on the shared history', () => {
    const shared = historyOf(120000)
    for (const model of [CLOUD_262K, CLOUD_262K, CLOUD_32K]) {
      const sent = applyChatSendBudget(shared, model)
      expect(sent.promptTokens).toBeLessThanOrEqual(chatSendBudget(model)!)
    }
  })

  it('a local member of the line-up keeps its 2.6.5 payload', () => {
    const shared = historyOf(120000)
    expect(applyChatSendBudget(shared, OLLAMA).messages).toBe(shared)
  })

  it('negative control: uncapped, one round bills the full history N times', () => {
    const shared = historyOf(120000)
    const perModel = [CLOUD_262K, CLOUD_262K, CLOUD_32K].map(
      (m) => applyChatSendBudget(shared, { ...m, contextDecay: false }).promptTokens,
    )
    expect(Math.min(...perModel)).toBeGreaterThan(100000)
  })
})

describe('A4: compare caps the shared base before the fan-out', () => {
  const bothSides = [CLOUD_262K, CLOUD_32K]

  it('takes the tightest of the two budgets', () => {
    expect(sharedChatSendBudget(bothSides)).toBe(Math.floor(32768 * 0.8))
  })

  it('sends both sides the same payload, under budget', () => {
    const history = historyOf(120000)
    const budget = sharedChatSendBudget(bothSides)!
    const sent = applySendBudget(history, budget)
    expect(sent.promptTokens).toBeLessThanOrEqual(budget)
    // One array, handed to A and to B: two models that were given different
    // prompts are not being compared.
    expect(applySendBudget(history, budget).messages.length).toBe(sent.messages.length)
  })

  it('two local models are not capped at all', () => {
    expect(sharedChatSendBudget([OLLAMA, OLLAMA])).toBeNull()
    const history = historyOf(50000)
    expect(applySendBudget(history, null).messages).toBe(history)
  })

  it('a mixed pairing takes the paid budget for both, so the prompts match', () => {
    expect(sharedChatSendBudget([OLLAMA, CLOUD_32K])).toBe(Math.floor(32768 * 0.8))
  })

  it('negative control: with the notaus off nothing is capped', () => {
    expect(sharedChatSendBudget(bothSides.map((s) => ({ ...s, contextDecay: false })))).toBeNull()
  })
})

describe('A4: the count cap stays the second barrier', () => {
  it('a chat of many short turns is cut by count even under the token budget', () => {
    const many: Wire[] = [{ role: 'system', content: 'be helpful' }]
    for (let i = 0; i < 600; i++) {
      many.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `t${i}` })
    }
    expect(size(many)).toBeLessThan(chatSendBudget(CLOUD_262K)!)
    const sent = applyChatSendBudget(many, CLOUD_262K)
    expect(sent.messages.length).toBeLessThanOrEqual(MAX_SEND_MESSAGES)
  })
})

describe('A4: old attachments are dropped on the chat path too', () => {
  it('reports the pictures it left behind', () => {
    const pixels = 'A'.repeat(40000)
    const history: Wire[] = [{ role: 'system', content: 'be helpful' }]
    for (let i = 1; i <= 6; i++) {
      history.push({ role: 'user', content: `q${i}`, images: [{ data: pixels, mimeType: 'image/png' }] })
      history.push({ role: 'assistant', content: `a${i}` })
    }
    const sent = applyChatSendBudget(history, CLOUD_262K)
    expect(sent.droppedImages).toBe(4)
    const rode = sent.messages.filter((m) => m.images?.length)
    expect(rode.map((m) => m.content)).toEqual(['q5', 'q6'])
  })

  it('negative control: with the notaus off all six ride along', () => {
    const pixels = 'A'.repeat(40000)
    const history: Wire[] = [{ role: 'system', content: 'be helpful' }]
    for (let i = 1; i <= 6; i++) {
      history.push({ role: 'user', content: `q${i}`, images: [{ data: pixels, mimeType: 'image/png' }] })
      history.push({ role: 'assistant', content: `a${i}` })
    }
    const sent = applyChatSendBudget(history, { ...CLOUD_262K, contextDecay: false })
    expect(sent.droppedImages).toBe(0)
    expect(sent.messages.filter((m) => m.images?.length)).toHaveLength(6)
  })
})
