/**
 * A completion claim that contradicts the plan must not end the run.
 *
 * Measured on R31 (gpt-oss-120b, Coding, LU Cloud, 2026-08-07): the model
 * wrote "All steps completed as requested" while its own todo list, rendered
 * live in the PlanBar, read PLAN 13/30. The loop agreed and ended the run 17
 * steps early. The plan length and the current step are client-side state, so
 * the contradiction is detectable without asking the model anything.
 *
 * Run: npx vitest run src/lib/__tests__/plan-reconcile.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { openPlanGap, planReconcileSteer, PLAN_RECONCILE_BUDGET } from '../plan-reconcile'
import type { TodoItem } from '../../stores/todoStore'

const t = (content: string, status: TodoItem['status']): TodoItem => ({ content, status })

describe('the R31 shape: finished claim, unfinished plan', () => {
  const r31 = [
    ...Array.from({ length: 13 }, (_, i) => t(`step ${i + 1}`, 'completed' as const)),
    t('Scaffold a new empty project in the subfolder scratch/demo.', 'in_progress'),
    ...Array.from({ length: 16 }, (_, i) => t(`step ${i + 15}`, 'pending' as const)),
  ]

  it('detects the gap', () => {
    expect(openPlanGap(r31)).toEqual({
      done: 13,
      total: 30,
      next: 'Scaffold a new empty project in the subfolder scratch/demo.',
    })
  })

  it('the steer names the numbers and the next step', () => {
    const msg = planReconcileSteer(openPlanGap(r31)!)
    expect(msg).toContain('13 of 30')
    expect(msg).toContain('scratch/demo')
    expect(msg).toContain('todo_write')
  })

  it('prefers the in_progress item over a later pending one', () => {
    const gap = openPlanGap([t('a', 'completed'), t('b', 'pending'), t('c', 'in_progress')])
    expect(gap?.next).toBe('c')
  })
})

describe('NEGATIVE CONTROL: legitimate endings stay endings', () => {
  it('no plan written, no steer', () => {
    expect(openPlanGap([])).toBeNull()
  })

  it('every step completed, no steer', () => {
    expect(openPlanGap([t('a', 'completed'), t('b', 'completed')])).toBeNull()
  })

  it('a single-item plan that is done, no steer', () => {
    expect(openPlanGap([t('only', 'completed')])).toBeNull()
  })

  it('the budget is small on purpose', () => {
    // Two ignored contradictions mean the model will not move; anything
    // larger only burns tokens against a stubborn model.
    expect(PLAN_RECONCILE_BUDGET).toBe(2)
  })
})

describe('both loops are wired, with their local names', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const codex = readFileSync(resolve(here, '../../hooks/useCodex.ts'), 'utf8')
  const agent = readFileSync(resolve(here, '../../hooks/useAgentChat.ts'), 'utf8')

  it('useCodex steers before break-no-toolcalls and exempts read-only turns', () => {
    expect(codex).toContain('openPlanGap(useTodoStore.getState().getTodos(convId))')
    const steerAt = codex.indexOf('planReconcileSteer(gap)')
    const breakAt = codex.indexOf("diagLog('break-no-toolcalls'")
    expect(steerAt).toBeGreaterThan(0)
    expect(steerAt).toBeLessThan(breakAt)
    expect(codex).toMatch(/!readOnlyTurn && convId && planReconcilesRemaining > 0/)
  })

  it('useAgentChat steers through agentMessages, never through `messages`', () => {
    expect(agent).toContain('agentMessages.push({ role: \'user\', content: planReconcileSteer(gap) })')
    expect(agent).not.toMatch(/\bmessages\.push\(\{ role: 'user', content: planReconcileSteer/)
    expect(agent).toMatch(/!opts\?\.readOnly && planReconcilesRemaining > 0/)
  })
})
