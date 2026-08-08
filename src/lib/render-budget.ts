/**
 * Render budget for agent-triggered generations (G19-1, R32 witness): the app
 * queued a 30 to 60 minute Wan render on an RTX 3060 inside an interactive
 * run, polled it 354 times and said nothing. The poll deadline alone is blind:
 * it burns its whole budget before admitting the job never had a chance.
 *
 * The tracker reads the pace off ComfyUI's own progress events (value/max per
 * sampler step) and projects how long the whole sampling pass will take. Once
 * enough steps are in, a projection clearly past the budget ends the wait
 * early with an honest, actionable message, and the job itself is abandoned so
 * the GPU stops burning (the timeout used to orphan it).
 */

/** Sampler steps observed before we trust the pace. */
export const MIN_STEPS_FOR_VERDICT = 3

/** A projection must overshoot the budget by this factor before we give up,
 *  so a render that would land a little late still gets to finish. */
export const HOPELESS_FACTOR = 1.25

interface PaceState {
  t0: number
  v0: number
  value: number
  max: number
  at: number
}

/**
 * Feed it ComfyUI `progress` ticks, ask it for the projected total. Pace is
 * measured from the FIRST tick, so model-load time never pollutes it. A value
 * that moves backwards means a new sampler node started (wan22 runs two
 * passes); re-anchor there. Projecting only the current pass under-estimates
 * multi-pass jobs, which errs on the side of letting them run.
 */
export class PaceTracker {
  private s: PaceState | null = null

  tick(value: number, max: number, at: number): void {
    if (!this.s || value < this.s.value) {
      this.s = { t0: at, v0: value, value, max, at }
      return
    }
    this.s.value = value
    this.s.max = max
    this.s.at = at
  }

  /** Projected ms for the whole sampling pass, or null before enough steps. */
  projectedTotalMs(): number | null {
    const s = this.s
    if (!s) return null
    const steps = s.value - s.v0
    if (steps < MIN_STEPS_FOR_VERDICT) return null
    return ((s.at - s.t0) / steps) * s.max
  }
}

export function overBudget(projectedTotalMs: number | null, budgetMs: number): boolean {
  return projectedTotalMs !== null && projectedTotalMs > budgetMs * HOPELESS_FACTOR
}

/**
 * Budget for the warm-up phase before the FIRST sampler progress event: model
 * load, VRAM swap, cold start (G24, R17c witness 2026-08-07: a Wan render sat
 * in "loading model into VRAM" for 19 minutes without one progress event, so
 * the pace tracker never engaged and a generous user timeout never fired; the
 * whole 20 minute run was lost to it). The promised swap is 30 to 90 s; this
 * sits well above that so only a genuinely wedged load trips it.
 */
export const SWAP_WARMUP_BUDGET_MS = 5 * 60_000

/**
 * True when the warm-up phase overran its budget. Deliberately narrow:
 *   - the WS must be connected, otherwise we are blind by design and only the
 *     flat deadline applies (exactly as before this guard existed);
 *   - NO prompt at all may have progressed. Progress on someone else's prompt
 *     means the GPU is busy, not wedged, and our job is just queued behind it;
 *     killing it there would punish a healthy queue.
 */
export function warmupExceeded(
  sawAnyProgress: boolean,
  wsConnected: boolean,
  elapsedMs: number,
  budgetMs: number = SWAP_WARMUP_BUDGET_MS,
): boolean {
  return wsConnected && !sawAnyProgress && elapsedMs > budgetMs
}

/** Tool result for a warm-up abort. Says what was observed, not a guess. */
export function swapWarmupNotice(kindLabel: string, elapsedMs: number): string {
  const m = Math.max(1, Math.round(elapsedMs / 60_000))
  return `${kindLabel} generation stopped: after ${m} minute${m === 1 ? '' : 's'} the model was still loading into VRAM and sampling never started. The job was cancelled so the GPU is free again. Free some VRAM (close other GPU apps, or set VRAM hand-off to "always" in Settings so the chat model is evicted first), or pick a smaller model.`
}

const advice = 'Try fewer frames, a smaller resolution or fewer steps, or pick a lighter model. The generation timeout is adjustable in Settings.'

/** Tool result for a pace-based early stop. Honest about what was measured. */
export function renderBudgetNotice(kindLabel: string, projectedMs: number, budgetMs: number): string {
  const p = Math.max(1, Math.round(projectedMs / 60_000))
  const b = Math.max(1, Math.round(budgetMs / 60_000))
  return `${kindLabel} generation stopped early: at the measured pace this render needs about ${p} minutes, more than the ${b} minute budget. The job was cancelled so the GPU is free again. ${advice}`
}

/** Tool result for the flat deadline. The job is abandoned, not orphaned. */
export function renderTimeoutNotice(kindLabel: string, budgetMs: number): string {
  const b = Math.max(1, Math.round(budgetMs / 60_000))
  return `${kindLabel} generation hit the ${b} minute budget and was cancelled so the GPU is free again. ${advice}`
}
