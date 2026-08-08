/**
 * A reasoning-only round must continue the run, not end it.
 *
 * R17 (Agent, Ollama, Qwen3-4B, 2026-08-07): step 1 of 31 fired, the next
 * round was all thought (the Qwen3 template puts the opening think tag in the
 * PROMPT, so whole rounds arrive as thinking), and the loop ended the run
 * with a stand-in sentence telling the USER to rephrase. The correct actor
 * was the LOOP, and the correct action was to continue.
 *
 * Run: npx vitest run src/lib/__tests__/reasoning-round.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { reasoningOnlyRound, REASONING_CONTINUE_BUDGET, REASONING_CONTINUE_STEER } from '../reasoning-round'

describe('the R17 shape', () => {
  it('thought, no words, no call: reasoning-only', () => {
    expect(reasoningOnlyRound('', 'I should now work through step 2 of the plan…')).toBe(true)
  })

  it('whitespace content is still reasoning-only', () => {
    expect(reasoningOnlyRound('  \n', 'planning…')).toBe(true)
  })
})

describe('NEGATIVE CONTROL: real endings stay endings', () => {
  it('an actual answer ends the run', () => {
    expect(reasoningOnlyRound('All 30 steps are done, results above.', 'final check…')).toBe(false)
  })

  it('an empty round with NO thinking is a dud, not a reasoning round', () => {
    // That case belongs to the dud-turn retry, not to this steer.
    expect(reasoningOnlyRound('', '')).toBe(false)
  })

  it('the budget is small on purpose', () => {
    expect(REASONING_CONTINUE_BUDGET).toBe(2)
  })

  it('the steer offers BOTH exits, act or answer, so a finished model is not trapped', () => {
    expect(REASONING_CONTINUE_STEER).toContain('tool call')
    expect(REASONING_CONTINUE_STEER).toContain('final answer')
  })
})

describe('the agent loop is wired in the right order', () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../hooks/useAgentChat.ts'),
    'utf8',
  )

  it('fires only after work started, inside the final-turn block', () => {
    expect(src).toMatch(/executedCallKeys\.size > 0 &&\s*\n\s*reasoningContinuesRemaining > 0 &&\s*\n\s*reasoningOnlyRound\(turnContent, turnThinking\)/)
  })

  it('the G16 plan reconcile stays ahead of it', () => {
    const g16 = src.indexOf('planReconcileSteer(gap)')
    const g17 = src.indexOf("content: REASONING_CONTINUE_STEER")
    expect(g16).toBeGreaterThan(0)
    expect(g17).toBeGreaterThan(g16)
  })

  it('steers through agentMessages, the array this hook actually has', () => {
    expect(src).toContain("agentMessages.push({ role: 'user', content: REASONING_CONTINUE_STEER })")
  })
})
