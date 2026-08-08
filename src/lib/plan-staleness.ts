/**
 * PlanBar lag (measured on the 2026-08-07 runs, next to G14-4): the bar read
 * PLAN 8/31 while the model was demonstrably narrating step 17. The bar only
 * renders what the model reports through todo_write, both system prompts
 * already demand an update after every step, and small models ignore it once
 * they get going. So the app notices the silence deterministically: batches of
 * real work keep landing while the plan has open items and none of them was a
 * todo_write. After PLAN_STALE_BATCHES of that, ONE steer asks for the update,
 * at most PLAN_STALE_STEER_BUDGET times per run so a model that will not
 * comply is not nagged forever.
 *
 * The steer asks the model to REPORT its own progress. It never invents plan
 * state: the store is only ever written by the model's todo_write.
 */
import type { PlanGap } from './plan-reconcile'

/** Executed tool batches without a todo_write before the plan counts as stale. */
export const PLAN_STALE_BATCHES = 3

/** Steers per run. Two is enough to recover a forgetful model once and prove
 *  an unwilling one will not comply. */
export const PLAN_STALE_STEER_BUDGET = 2

/** One instance per run, fed once per executed tool batch. */
export class PlanStaleness {
  private quiet = 0
  private steersLeft = PLAN_STALE_STEER_BUDGET

  /** Returns true when the steer should fire NOW (and consumes budget). */
  recordBatch(toolNames: string[], hasOpenPlan: boolean): boolean {
    if (!hasOpenPlan || toolNames.length === 0 || toolNames.includes('todo_write')) {
      this.quiet = 0
      return false
    }
    this.quiet++
    if (this.quiet >= PLAN_STALE_BATCHES && this.steersLeft > 0) {
      this.quiet = 0
      this.steersLeft--
      return true
    }
    return false
  }
}

export function planStalenessSteer(gap: PlanGap): string {
  return (
    `Your plan still shows ${gap.done} of ${gap.total} steps completed and has not been updated while you worked. ` +
    `Bring it up to date NOW with one todo_write call: send the full list, mark every finished step completed, and mark the step you are actually on as the single in_progress item. ` +
    `Then continue with the work. The list currently names "${gap.next}" as the next step.`
  )
}
