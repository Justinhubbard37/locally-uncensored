import type { TodoItem } from '../stores/todoStore'
import { openPlanGap, type PlanGap } from './plan-reconcile'

/**
 * The line that makes "continue" deterministic.
 *
 * Measured by David on the running build (2026-08-22): an agent run with a
 * plan was interrupted by a side question the model could not answer, it
 * replied in prose and left the plan lying there. Sending "continue" then
 * asked the model to FIND its own plan again somewhere in the history, and
 * that is hope, not a mechanism. Two things make the search fail outright:
 * the coding loop persists only the last 60 messages of its hidden tool chain
 * (useCodex HIDDEN_HISTORY_MAX), so on a long run the newest todo_write is
 * simply gone from the next turn, and the agent loop persists no hidden tool
 * chain at all, so no todo_write ever reaches the following request.
 *
 * The plan itself never went anywhere: it lives in the todoStore, keyed by
 * conversation and persisted across restarts, and the PlanBar renders it the
 * whole time. So the state the model is asked to rediscover is state the app
 * already holds. This turns it into one short line on the new turn.
 *
 * Two properties it must keep:
 *   - the numbers come from the STORE, never from the history that just aged
 *     out, which is the whole reason the anchor exists;
 *   - the user still outranks the plan. A new message that changes direction
 *     is an instruction, not a distraction, and the plan waits or gets
 *     rewritten with todo_write.
 *
 * Placement is plan A5: the anchor rides at the END of the request, behind the
 * user's own message, never in the stable head and never in the visible
 * history. It is pushed into the request copy exactly once per turn, and it
 * touches neither the reconcile budget nor the staleness budget: those two
 * argue with a model DURING a run, this one hands over state BETWEEN runs.
 */

export interface PlanResume {
  gap: PlanGap
  text: string
}

/** The anchor for a new turn, or null when there is no open plan to resume. */
export function planResumeAnchor(todos: TodoItem[]): PlanResume | null {
  const gap = openPlanGap(todos)
  if (!gap) return null
  return {
    gap,
    text:
      `A plan from this conversation is still open: ${gap.done} of ${gap.total} steps completed, ` +
      `next open step: "${gap.next}". Continue with it now, ` +
      `unless the message above clearly sends you somewhere else. ` +
      `If it does, that instruction comes first; take the plan up again afterwards, ` +
      `or rewrite it with todo_write once you know it no longer fits.`,
  }
}
