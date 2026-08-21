/**
 * A3: cache-friendly compaction (2.6.6 plan).
 *
 * Trimming to exactly the budget on every step moves the prompt prefix on every
 * step, and an upstream prefix cache matches from byte 0 and stops at the first
 * difference. So the plateau of a long run was billed at full price every time
 * even though 95 percent of the prompt was the same bytes as a second earlier.
 *
 * Hysteresis: wait until 15 percent over budget, then drop in one block to 70
 * percent of it. In between, the array passes through untouched.
 *
 * The prefix test deliberately runs WITH the A1 decay active. Testing it with
 * decay off would prove the wrong thing: the two features have to be stable
 * TOGETHER, and decay is the one that moves bytes on purpose.
 */

import { describe, it, expect } from 'vitest'
import {
  compactMessages,
  estimateMessageTokens,
  COMPACT_TRIGGER_RATIO,
  COMPACT_TARGET_RATIO,
} from '../context-compaction'
import { buildRequestMessages, trimWorkingHistory, type DecayMessage } from '../context-decay'
import type { OllamaChatMessage } from '../../types/agent-mode'

/** Text of a given token size, roughly (the estimator is chars/4). */
const sized = (label: string, tokens: number) =>
  `${label}:` + 'x'.repeat(Math.max(0, tokens * 4 - label.length - 1))

function historyOfTokens(sizes: number[]): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = [
    { role: 'system', content: sized('SYS', 100) } as OllamaChatMessage,
    { role: 'user', content: sized('TASK', 50) } as OllamaChatMessage,
  ]
  sizes.forEach((t, i) => {
    out.push({ role: 'assistant', content: sized(`A${i}`, 20) } as OllamaChatMessage)
    out.push({ role: 'tool', content: sized(`R${i}`, t) } as OllamaChatMessage)
  })
  return out
}

describe('A3: the hysteresis band', () => {
  it('leaves a history that is over budget but under the trigger untouched', () => {
    // ~1050 tokens against a 1000 budget: over, but inside the 15 percent band.
    const history = historyOfTokens([200, 200, 200, 200])
    const total = estimateMessageTokens(history)
    const budget = Math.floor(total / COMPACT_TRIGGER_RATIO) + 20
    expect(total).toBeGreaterThan(budget)
    expect(total).toBeLessThan(budget * COMPACT_TRIGGER_RATIO)

    const out = compactMessages(history, budget, { hysteresis: true })
    expect(out).toBe(history)
  })

  it('negative control: without hysteresis the same history is compacted', () => {
    const history = historyOfTokens([200, 200, 200, 200])
    const total = estimateMessageTokens(history)
    const budget = Math.floor(total / COMPACT_TRIGGER_RATIO) + 20
    const out = compactMessages(history, budget)
    expect(estimateMessageTokens(out)).toBeLessThan(total)
  })

  it('drops well below the budget once the trigger is crossed', () => {
    const history = historyOfTokens([150, 150, 150, 150, 150, 150, 150, 150])
    const budget = 1000
    expect(estimateMessageTokens(history)).toBeGreaterThan(budget * COMPACT_TRIGGER_RATIO)

    const out = compactMessages(history, budget, { hysteresis: true })
    const after = estimateMessageTokens(out)
    expect(after).toBeLessThan(budget)
    // The block drop targets 0.7 of the budget, so there is real headroom for
    // the next steps rather than an immediate re-trim.
    expect(after).toBeLessThan(budget * COMPACT_TARGET_RATIO * 1.6)
  })

  it('is stateless: the same input always decides the same way', () => {
    const history = historyOfTokens([150, 150, 150, 150, 150, 150, 150, 150])
    const a = compactMessages(history, 1000, { hysteresis: true })
    const b = compactMessages(history, 1000, { hysteresis: true })
    expect(a.map((m) => m.content)).toEqual(b.map((m) => m.content))
  })
})

/** One more read step, appended the way the loops append them. */
function appendStep(history: DecayMessage[], n: number, resultChars: number): DecayMessage[] {
  return [
    ...history,
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `c${n}`, function: { name: 'file_read', arguments: { path: `f${n}.ts` } } }],
    },
    { role: 'tool', content: `RESULT${n} ` + 'y'.repeat(resultChars), tool_call_id: `c${n}` },
  ]
}

/**
 * Walk a plateau the way the loops really do: the trimmed history is what gets
 * carried into the next step. Returns how many steps moved the prompt PREFIX,
 * i.e. changed more than the single message the age decay is allowed to flip.
 * Zero would mean the whole plateau is one long cache hit; one per step is what
 * the old trim-to-the-budget did.
 */
function prefixMovesOverPlateau(steps: number, budget: number, on: boolean): number {
  let history: DecayMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT, stable across the whole run.' },
    { role: 'user', content: 'refactor the parser' },
  ]
  let previous: ReturnType<typeof buildRequestMessages<DecayMessage>> | null = null
  let moves = 0
  for (let step = 1; step <= steps; step++) {
    history = appendStep(history, step, 12000)
    history = trimWorkingHistory(history, budget, { enabled: on }).messages
    const next = buildRequestMessages(history, { budgetTokens: budget, hysteresis: on, enabled: on })
    if (previous) {
      const shared = Math.min(previous.messages.length, next.messages.length)
      let differing = 0
      for (let i = 0; i < shared; i++) {
        if (previous.messages[i].content !== next.messages[i].content) differing++
      }
      if (differing > 1) moves++
    }
    previous = next
  }
  return moves
}

describe('A3: the prefix holds still at the plateau, with decay running', () => {
  // 12000 tokens is well below what thirty 12k-character results cost, so
  // compaction genuinely has to fire; it is also comfortably above one newest
  // result plus the four messages compaction always keeps, so the block drop
  // can reach its target instead of clamping.
  const BUDGET = 12000
  const STEPS = 30

  it('moves the prefix a handful of times over thirty steps', () => {
    expect(prefixMovesOverPlateau(STEPS, BUDGET, true)).toBeLessThanOrEqual(5)
  })

  it('negative control: with the 2.6.5 behaviour it moves on most steps', () => {
    expect(prefixMovesOverPlateau(STEPS, BUDGET, false)).toBeGreaterThanOrEqual(12)
  })

  it('holds a long stretch of steps byte-identical, not just alternating ones', () => {
    let history: DecayMessage[] = [
      { role: 'system', content: 'SYSTEM PROMPT, stable across the whole run.' },
      { role: 'user', content: 'refactor the parser' },
    ]
    let previous: ReturnType<typeof buildRequestMessages<DecayMessage>> | null = null
    let streak = 0
    let longest = 0
    for (let step = 1; step <= 30; step++) {
      history = appendStep(history, step, 12000)
      history = trimWorkingHistory(history, BUDGET, { enabled: true }).messages
      const next = buildRequestMessages(history, { budgetTokens: BUDGET, hysteresis: true })
      if (previous) {
        const shared = Math.min(previous.messages.length, next.messages.length)
        let differing = 0
        for (let i = 0; i < shared; i++) {
          if (previous.messages[i].content !== next.messages[i].content) differing++
        }
        if (differing <= 1) {
          streak++
          longest = Math.max(longest, streak)
        } else {
          streak = 0
        }
      }
      previous = next
    }
    expect(longest).toBeGreaterThanOrEqual(5)
  })

  it('never sends more than the hysteresis ceiling of budget times 1.15', () => {
    let history: DecayMessage[] = [
      { role: 'system', content: 'SYSTEM PROMPT, stable across the whole run.' },
      { role: 'user', content: 'refactor the parser' },
    ]
    for (let step = 1; step <= 30; step++) {
      history = appendStep(history, step, 12000)
      history = trimWorkingHistory(history, BUDGET, { enabled: true }).messages
      const built = buildRequestMessages(history, { budgetTokens: BUDGET, hysteresis: true })
      expect(built.promptTokens).toBeLessThanOrEqual(BUDGET * COMPACT_TRIGGER_RATIO)
    }
  })

  it('the carried history keeps every result whole, however often it is trimmed', () => {
    // The store and the next session read this array. Nothing in it may ever
    // be shortened; only whole messages leave.
    let history: DecayMessage[] = [
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'go' },
    ]
    for (let step = 1; step <= 20; step++) {
      history = appendStep(history, step, 12000)
      history = trimWorkingHistory(history, BUDGET, { enabled: true }).messages
    }
    const results = history.filter((m) => m.role === 'tool')
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      // Full length, not the 4k the request went out with.
      expect(String(r.content).length).toBeGreaterThan(12000)
      expect(String(r.content)).not.toContain('truncated')
    }
  })

  it('the notaus lands on the plain budget, not on a third behaviour', () => {
    // Flipping contextDecay off is a support move. It has to reproduce what
    // 2.6.5 did: full results, and a window trimmed to the budget itself
    // rather than to 70 percent of it.
    let history: DecayMessage[] = [
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'go' },
    ]
    for (let step = 1; step <= 12; step++) {
      history = appendStep(history, step, 12000)
      history = trimWorkingHistory(history, BUDGET, { enabled: false, hysteresis: false }).messages
    }
    const off = buildRequestMessages(history, { budgetTokens: BUDGET, enabled: false, hysteresis: false })
    expect(off.trimmedCount).toBe(0)
    expect(off.prunedPlans).toBe(0)
    for (const m of off.messages) {
      expect(String(m.content ?? '')).not.toContain('truncated')
    }
    expect(off.promptTokens).toBeLessThanOrEqual(BUDGET)
  })

  it('the notaus trims at the budget while the band waits for 15 percent more', () => {
    // A history sitting between the budget and the trigger is exactly where
    // the two behaviours part company.
    let history: DecayMessage[] = [
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'go' },
    ]
    let step = 0
    while (estimateMessageTokens(history as never) <= BUDGET && step < 40) {
      history = appendStep(history, ++step, 12000)
    }
    const raw = estimateMessageTokens(history as never)
    expect(raw).toBeGreaterThan(BUDGET)
    expect(raw).toBeLessThan(BUDGET * COMPACT_TRIGGER_RATIO)

    const banded = trimWorkingHistory(history, BUDGET, { enabled: false, hysteresis: true })
    const plain = trimWorkingHistory(history, BUDGET, { enabled: false, hysteresis: false })
    expect(banded.dropped).toBe(0)
    expect(plain.dropped).toBeGreaterThan(0)
  })

  it('trimming never opens the window on an orphan tool result', () => {
    let history: DecayMessage[] = [
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'go' },
    ]
    for (let step = 1; step <= 25; step++) {
      history = appendStep(history, step, 12000)
      history = trimWorkingHistory(history, BUDGET, { enabled: true }).messages
      const firstNonSystem = history.find((m) => m.role !== 'system')
      expect(firstNonSystem?.role).not.toBe('tool')
    }
  })
})
