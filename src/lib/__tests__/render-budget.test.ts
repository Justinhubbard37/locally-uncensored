/**
 * Render budget for agent-triggered generations (G19-1, R32 witness 2026-08-07):
 * the app queued a 30 to 60 minute Wan render inside an interactive run, polled
 * it 354 times with nothing on screen, and the timeout would have walked away
 * leaving the job burning the GPU. The pace tracker projects the sampling pass
 * off ComfyUI's own progress events and gives up early, cancelling the job.
 *
 * Run: npx vitest run src/lib/__tests__/render-budget.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  PaceTracker,
  overBudget,
  renderBudgetNotice,
  renderTimeoutNotice,
  warmupExceeded,
  swapWarmupNotice,
  MIN_STEPS_FOR_VERDICT,
  HOPELESS_FACTOR,
  SWAP_WARMUP_BUDGET_MS,
} from '../render-budget'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

describe('PaceTracker projection', () => {
  it('projects the R32 case: 30 steps at 80s each is a 40 minute job', () => {
    const t = new PaceTracker()
    // first tick anchors, three more ticks give a measurable pace
    t.tick(1, 30, 0)
    t.tick(2, 30, 80_000)
    t.tick(3, 30, 160_000)
    t.tick(4, 30, 240_000)
    expect(t.projectedTotalMs()).toBe(30 * 80_000)
  })

  it('NEGATIVE CONTROL: stays silent before enough steps are in', () => {
    const t = new PaceTracker()
    t.tick(1, 30, 0)
    t.tick(2, 30, 80_000)
    expect(t.projectedTotalMs()).toBeNull()
    // and a tracker that never saw a tick (no WS) never judges
    expect(new PaceTracker().projectedTotalMs()).toBeNull()
  })

  it('re-anchors when a second sampler pass starts (value moves backwards)', () => {
    const t = new PaceTracker()
    t.tick(28, 30, 0)
    t.tick(30, 30, 4_000)
    t.tick(1, 30, 10_000)
    t.tick(2, 30, 12_000)
    t.tick(3, 30, 14_000)
    t.tick(4, 30, 16_000)
    // pace comes from the NEW pass (2s per step), not the stale anchor
    expect(t.projectedTotalMs()).toBe(30 * 2_000)
  })
})

describe('the verdict', () => {
  it('a hopeless projection is over budget, a close one is not', () => {
    const budget = 10 * 60_000
    expect(overBudget(40 * 60_000, budget)).toBe(true)
    // NEGATIVE CONTROL: a render that lands a LITTLE late gets to finish
    expect(overBudget(11 * 60_000, budget)).toBe(false)
    expect(overBudget(null, budget)).toBe(false)
    expect(HOPELESS_FACTOR).toBeGreaterThan(1)
    expect(MIN_STEPS_FOR_VERDICT).toBeGreaterThanOrEqual(2)
  })

  it('both notices are honest and actionable, without inventing model prose', () => {
    const early = renderBudgetNotice('Video', 40 * 60_000, 10 * 60_000)
    expect(early).toContain('about 40 minutes')
    expect(early).toContain('10 minute budget')
    expect(early).toContain('cancelled')
    const flat = renderTimeoutNotice('Video', 10 * 60_000)
    expect(flat).toContain('10 minute budget')
    for (const msg of [early, flat]) {
      expect(msg).toContain('Settings')
      expect(msg).toMatch(/^Video generation/)
    }
  })
})

describe('the warm-up budget (G24, R17c witness)', () => {
  it('R17c: WS alive, nothing on the GPU ever progressed, budget spent, job dies', () => {
    expect(warmupExceeded(false, true, SWAP_WARMUP_BUDGET_MS + 1)).toBe(true)
  })

  it('the budget sits well above the promised 30 to 90 s swap', () => {
    expect(SWAP_WARMUP_BUDGET_MS).toBeGreaterThanOrEqual(3 * 60_000)
  })

  it('NEGATIVE CONTROL: without a WS we stay blind, only the flat deadline applies', () => {
    expect(warmupExceeded(false, false, SWAP_WARMUP_BUDGET_MS * 10)).toBe(false)
  })

  it('NEGATIVE CONTROL: a slow load that is still inside the budget gets to finish', () => {
    expect(warmupExceeded(false, true, SWAP_WARMUP_BUDGET_MS - 1)).toBe(false)
  })

  it('NEGATIVE CONTROL: progress on ANY prompt means busy, not wedged, no kill', () => {
    // A healthy job queued behind another client's render must not be punished.
    expect(warmupExceeded(true, true, SWAP_WARMUP_BUDGET_MS * 10)).toBe(false)
  })

  it('the notice says what was observed and how to get out of it', () => {
    const msg = swapWarmupNotice('Video', 5 * 60_000)
    expect(msg).toContain('5 minutes')
    expect(msg).toContain('still loading into VRAM')
    expect(msg).toContain('cancelled')
    expect(msg).toContain('Settings')
    expect(msg).toMatch(/^Video generation/)
  })
})

describe('wiring in the poll loop', () => {
  const handoff = read('../../api/vram-handoff.ts')

  it('the poll loop feeds progress events into the tracker and checks the budget', () => {
    expect(handoff).toContain("if (ev.type === 'progress') {")
    expect(handoff).toContain('pace.tick(ev.data.value, ev.data.max, Date.now())')
    expect(handoff).toContain('if (overBudget(projected, timeoutMs))')
  })

  it('ALL THREE exits abandon the job instead of orphaning it', () => {
    // pace verdict, warm-up verdict (G24), flat deadline
    expect(handoff.match(/await abandonPrompt\(promptId\)/g)?.length).toBe(3)
    expect(handoff).not.toContain('generation timed out after')
  })

  it('G24: the loop tracks warm-up with ANY-prompt progress and the live WS state', () => {
    expect(handoff).toContain('sawAnyProgress = true')
    expect(handoff).toContain('warmupExceeded(sawAnyProgress, comfyWS.connected, warmupElapsed)')
    // own-prompt ticks still feed the pace tracker underneath the any-progress flag
    expect(handoff).toContain("if (ev.data.prompt_id === promptId) {")
  })

  it('the WS listener is always released', () => {
    expect(handoff).toContain('offProgress()')
  })

  it('abandonPrompt kills only OUR job: pending delete first, interrupt only if ours runs', () => {
    const comfy = read('../../api/comfyui.ts')
    const fn = comfy.slice(comfy.indexOf('export async function abandonPrompt'))
    expect(fn.indexOf('delete: [promptId]')).toBeGreaterThan(-1)
    expect(fn.indexOf('delete: [promptId]')).toBeLessThan(fn.indexOf('cancelGeneration()'))
    expect(fn).toContain('if (running) await cancelGeneration()')
  })

  it('NEGATIVE CONTROL: the user cancel path is untouched', () => {
    expect(handoff).toContain('if (_genCancelRequested) return `${kindLabel} generation cancelled.`')
  })
})
