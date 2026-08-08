/**
 * PlanBar lag (measured 2026-08-07): PLAN 8/31 on the bar while the model
 * narrated step 17. The bar renders only what the model reports through
 * todo_write, so when batches of real work keep landing without one, the loop
 * asks the model ONCE (budgeted) to bring its own list current. The app never
 * invents plan state.
 *
 * Run: npx vitest run src/lib/__tests__/plan-staleness.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  PlanStaleness,
  planStalenessSteer,
  PLAN_STALE_BATCHES,
  PLAN_STALE_STEER_BUDGET,
} from '../plan-staleness'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

const work = ['file_write', 'shell_execute']

describe('PlanStaleness', () => {
  it('fires after enough silent batches, then re-arms only after another stretch', () => {
    const s = new PlanStaleness()
    expect(s.recordBatch(work, true)).toBe(false)
    expect(s.recordBatch(work, true)).toBe(false)
    expect(s.recordBatch(work, true)).toBe(true)
    // counter reset: the very next batch is not stale again
    expect(s.recordBatch(work, true)).toBe(false)
    expect(s.recordBatch(work, true)).toBe(false)
    expect(s.recordBatch(work, true)).toBe(true)
    // budget of 2 is spent: silence forever after
    for (let i = 0; i < 10; i++) expect(s.recordBatch(work, true)).toBe(false)
    expect(PLAN_STALE_STEER_BUDGET).toBe(2)
    expect(PLAN_STALE_BATCHES).toBe(3)
  })

  it('NEGATIVE CONTROL: a todo_write in the batch resets the clock', () => {
    const s = new PlanStaleness()
    s.recordBatch(work, true)
    s.recordBatch(work, true)
    expect(s.recordBatch([...work, 'todo_write'], true)).toBe(false)
    // the two silent batches before the update no longer count
    expect(s.recordBatch(work, true)).toBe(false)
    expect(s.recordBatch(work, true)).toBe(false)
    expect(s.recordBatch(work, true)).toBe(true)
  })

  it('NEGATIVE CONTROL: no plan, no nagging, ever', () => {
    const s = new PlanStaleness()
    for (let i = 0; i < 10; i++) expect(s.recordBatch(work, false)).toBe(false)
    // a plan appearing later starts a FRESH count
    expect(s.recordBatch(work, true)).toBe(false)
  })

  it('NEGATIVE CONTROL: empty batches (no executed tools) do not accumulate', () => {
    const s = new PlanStaleness()
    for (let i = 0; i < 10; i++) expect(s.recordBatch([], true)).toBe(false)
  })

  it('the steer asks the model to report, never claims progress itself', () => {
    const msg = planStalenessSteer({ done: 8, total: 31, next: 'run the tests' })
    expect(msg).toContain('8 of 31')
    expect(msg).toContain('todo_write')
    expect(msg).toContain('"run the tests"')
    // it must not assert that any step IS done; the model decides that
    expect(msg).not.toMatch(/step \d+ is (now )?completed/i)
  })
})

describe('wiring in both loops', () => {
  it('Agent and Codex each own one tracker per run and steer after the batch', () => {
    for (const f of ['../../hooks/useAgentChat.ts', '../../hooks/useCodex.ts']) {
      const src = read(f)
      expect(src, f).toContain('const planStaleness = new PlanStaleness()')
      expect(src, f).toContain('planStaleness.recordBatch(')
      expect(src, f).toContain('planStalenessSteer(staleGap)')
    }
  })

  it('the steer rides the run transcript: agentMessages in Agent, messages in Codex', () => {
    expect(read('../../hooks/useAgentChat.ts')).toContain("agentMessages.push({ role: 'user', content: planStalenessSteer(staleGap) })")
    expect(read('../../hooks/useCodex.ts')).toContain("messages.push({ role: 'user', content: planStalenessSteer(staleGap) })")
  })

  it('NEGATIVE CONTROL: the G16 finish-time reconcile keeps its own budget', () => {
    for (const f of ['../../hooks/useAgentChat.ts', '../../hooks/useCodex.ts']) {
      const src = read(f)
      expect(src, f).toContain('planReconcilesRemaining = PLAN_RECONCILE_BUDGET')
      expect(src, f).toContain('planReconcileSteer(gap)')
    }
  })
})
