/**
 * The plan bar reports the MODEL's progress. In Stage-and-Approve the writes
 * still sit in the queue, so "every step done" on its own reads as "your files
 * are written" when nothing was. Morgan (2026-08-11) saw exactly that: plan
 * 6 of 6, every step done, and six file changes that had all been refused.
 *
 * Since 2.6.6 C2 the coding tab shows this in the right-hand panel instead of
 * above the prompt, so the same claims are now tested on the panel variant:
 * the staged-changes coupling and the clear button moved with it, and the
 * composer above the input no longer carries a plan at all.
 *
 * Run: npx vitest run src/components/chat/__tests__/plan-done-vs-applied.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { planDoneLabel } from '../PlanBar'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

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
    const src = read('../PlanBar.tsx')
    expect(src).toMatch(/useStagedChangesStore/)
    expect(src).toMatch(/planDoneLabel\(pending\)/)
  })

  it('the warning survives the panel, where the list is open by default', () => {
    const src = read('../PlanBar.tsx')
    // Collapsed-only would have hidden the Morgan line in the panel, because
    // the panel starts expanded.
    expect(src).toMatch(/\(panel \|\| !expanded\) && allDone/)
    expect(src).toMatch(/useState\(panel\)/)
  })
})

describe('the plan moved into the panel (C2)', () => {
  it('PlanBar has a panel variant without the composer width wrapper', () => {
    const src = read('../PlanBar.tsx')
    expect(src).toMatch(/variant = 'composer'/)
    expect(src).toMatch(/panel = variant === 'panel'/)
    // The 70% wrapper belongs to the composer only; in a 280px column it would
    // squeeze the plan into a third of the panel.
    expect(src).toMatch(/panel \? 'w-full p-1\.5' : 'w-full max-w-\[70%\]/)
  })

  it('the clear button and the staged count came along, unchanged', () => {
    const src = read('../PlanBar.tsx')
    expect(src).toMatch(/clearTodos\(activeConversationId\)/)
    expect(src).toMatch(/s\.byChat\[activeConversationId\]\?\.length \?\? 0/)
  })

  it('the coding composer no longer carries a plan', () => {
    const src = read('../CodexView.tsx')
    // C1 added the plan APPROVAL card here (a button plus the plan text the
    // user is approving); the plan itself still lives only in the panel.
    expect(src).toMatch(/composerAbove=\{<><LoopBar onStop=\{stopCodex\} \/><GoalBar \/><PlanApprovalBar /)
    expect(src).not.toMatch(/PlanBar/)
  })

  it('the panel renders it, above the tree', () => {
    const src = read('../ExplorerPanel.tsx')
    expect(src).toMatch(/<PlanBar variant="panel" \/>/)
    const plan = src.indexOf('<PlanBar variant="panel" />')
    const tree = src.indexOf('{rows.map((row) => {')
    expect(plan).toBeGreaterThan(-1)
    expect(tree).toBeGreaterThan(plan)
  })

  it('counter-test: the chat tab keeps the plan above its composer', () => {
    // Only the Code tab moved. ChatView is not ours to change and must still
    // render the composer variant.
    const src = read('../ChatView.tsx')
    expect(src).toMatch(/<PlanBar \/>/)
  })
})
