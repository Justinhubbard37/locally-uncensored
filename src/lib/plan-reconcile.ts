import type { TodoItem } from '../stores/todoStore'

/**
 * The loop's own answer to a false completion claim.
 *
 * Measured on R31 (gpt-oss-120b, Coding, LU Cloud, 2026-08-07): the model
 * wrote "All steps completed as requested" while the PlanBar, fed by the very
 * todo list the model maintains, read PLAN 13/30. The task text said "do not
 * stop early" in so many words. Nothing reconciled the two, so the run ended
 * and the claim stood.
 *
 * The plan length and the current step are already client-side state; whether
 * the run may end is therefore decidable without asking the model anything.
 * When the final turn arrives while the plan has open items, the loop gets a
 * bounded number of corrective steers naming the next open step. Bounded,
 * because a model that ignores two direct contradictions will ignore ten, and
 * an unbounded loop against a stubborn model is its own failure mode.
 */

export interface PlanGap {
  done: number
  total: number
  /** The first in_progress item, or the first pending one. */
  next: string
}

/** Steers per run. Two contradictions ignored means the model will not move. */
export const PLAN_RECONCILE_BUDGET = 2

/**
 * The gap between "the model stopped" and "the plan is done", or null when
 * ending now is legitimate: no plan was written, or every item is completed.
 */
export function openPlanGap(todos: TodoItem[]): PlanGap | null {
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  if (done >= todos.length) return null
  const next = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending')
  if (!next) return null
  return { done, total: todos.length, next: next.content }
}

export function planReconcileSteer(gap: PlanGap): string {
  return (
    `Your own todo list shows ${gap.done} of ${gap.total} steps completed, so the task is NOT finished. ` +
    `Do not declare completion while steps are open. Continue now with the next open step: "${gap.next}". ` +
    `Execute it as a tool call, then update the list with todo_write once it actually succeeded.`
  )
}
