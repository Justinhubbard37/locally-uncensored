/**
 * The plan bar reports the MODEL's progress. In Stage-and-Approve the writes
 * still sit in the queue, so "every step done" on its own reads as "your files
 * are written" when nothing was. Morgan (2026-08-11) saw exactly that: plan
 * 6 of 6, every step done, and six file changes that had all been refused.
 *
 * Run: npx vitest run src/components/chat/__tests__/plan-done-vs-applied.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { planDoneLabel } from '../PlanBar'

describe('planDoneLabel', () => {
  it('says done, plainly, when nothing is waiting', () => {
    expect(planDoneLabel(0)).toBe('every step done')
  })

  it('names the changes that still need approval', () => {
    expect(planDoneLabel(1)).toBe('every step done, 1 change still waiting for your approval')
    expect(planDoneLabel(6)).toBe('every step done, 6 changes still waiting for your approval')
  })
})

describe('the bar reads the staging queue', () => {
  it('PlanBar subscribes to stagedChangesStore', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, '../PlanBar.tsx'), 'utf8')
    expect(src).toMatch(/useStagedChangesStore/)
    expect(src).toMatch(/planDoneLabel\(pending\)/)
  })
})
