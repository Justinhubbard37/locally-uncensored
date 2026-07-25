/**
 * Read-only turns must be enforced where the tools RUN, not only where they are
 * offered.
 *
 * Live on the ship exe, 2026-07-25: /plan is read-only, every one of its six
 * requests carried a catalog of file_read / file_list / file_search only, and
 * it still created helper.js on disk. The loose-parse fallback lifts a call the
 * model wrote as prose and hands the name to toolRegistry.execute, which
 * resolves by name and never asks whether this turn was allowed to offer it.
 * Code Review Mode carried the same hole and made the same promise.
 *
 * These tests pin the guard itself (the filter both hooks apply to a batch) and
 * assert the source still contains it, so the belt cannot quietly come off
 * again.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { MUTATING_TOOLS } from '../mutating-tools'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')

type Call = { function: { name: string } }
/** The guard both hooks apply before a batch executes. */
const applyGuard = (calls: Call[], readOnly: boolean) =>
  readOnly ? calls.filter((c) => !MUTATING_TOOLS.has(c.function?.name ?? '')) : calls

const call = (name: string): Call => ({ function: { name } })

describe('read-only batch guard', () => {
  it('drops a write the model smuggled in as text', () => {
    const batch = [call('file_read'), call('file_write'), call('file_search')]
    expect(applyGuard(batch, true).map((c) => c.function.name)).toEqual(['file_read', 'file_search'])
  })

  it('drops every mutating tool, not just the file ones', () => {
    const batch = [...MUTATING_TOOLS].map(call)
    expect(applyGuard(batch, true)).toEqual([])
  })

  it('leaves the read tools alone', () => {
    const reads = ['file_read', 'file_list', 'file_search', 'git_status', 'git_diff', 'git_log'].map(call)
    expect(applyGuard(reads, true)).toHaveLength(reads.length)
  })

  it('changes nothing on a normal turn', () => {
    const batch = [call('file_write'), call('shell_execute')]
    expect(applyGuard(batch, false)).toHaveLength(2)
  })

  it('git inspection is not classified as mutating', () => {
    // A reviewer still has to be able to look at the diff it is reviewing.
    for (const t of ['git_status', 'git_diff', 'git_log', 'file_read', 'file_list', 'file_search']) {
      expect(MUTATING_TOOLS.has(t), `${t} must stay available`).toBe(false)
    }
  })

  it('the tools that can actually change something are all listed', () => {
    for (const t of ['file_write', 'file_edit', 'shell_execute', 'code_execute', 'git_commit', 'git_push', 'gh_pr_create']) {
      expect(MUTATING_TOOLS.has(t), `${t} must be blocked`).toBe(true)
    }
  })
})

describe('both hooks still carry the guard', () => {
  it('useCodex filters the batch, not just the catalog', () => {
    const src = read('../../hooks/useCodex.ts')
    expect(src).toContain('if (settings.codexReviewMode || readOnlyTurn) {')
    expect(src).toContain('toolCalls = toolCalls.filter((tc) => !MUTATING_TOOLS.has(tc.function?.name ?? \'\'))')
  })

  it('useAgentChat filters the batch too', () => {
    const src = read('../../hooks/useAgentChat.ts')
    expect(src).toContain('if (opts?.readOnly) {')
    expect(src).toContain('toolCalls = toolCalls.filter((tc) => !MUTATING_TOOLS.has(tc.function?.name ?? \'\'))')
  })

  it('the blocklist has exactly one definition', () => {
    // It lived inline in useCodex, which is part of why Agent mode never had it.
    for (const f of ['../../hooks/useCodex.ts', '../../hooks/useAgentChat.ts']) {
      expect(read(f)).toContain("from '../lib/mutating-tools'")
    }
  })
})

describe('/loop budget is enforced in the run, not just stated', () => {
  it('useCodex checks the wall clock between iterations', () => {
    const src = read('../../hooks/useCodex.ts')
    // The deadline has to be derived from the command, not from a setting.
    expect(src).toContain("slash?.command.name === 'loop' ? parseLoopBudget(slash.args).budgetMs : null")
    expect(src).toContain('if (loopDeadline && Date.now() > loopDeadline && i > 0)')
    // And it must report the stop rather than going quiet.
    expect(src).toContain('time is up')
  })

  it('the check sits at the TOP of the iteration, never mid-tool', () => {
    const src = read('../../hooks/useCodex.ts')
    const loopHead = src.indexOf('for (let i = 0; i < MAX_CODEX_ITERATIONS')
    const deadline = src.indexOf('if (loopDeadline && Date.now() > loopDeadline')
    const firstExec = src.indexOf('budget.addToolCalls(')
    expect(loopHead).toBeGreaterThan(0)
    expect(deadline).toBeGreaterThan(loopHead)
    // Cutting a run off inside file_edit or a shell command would leave the
    // workspace in a state nobody asked for.
    expect(deadline).toBeLessThan(firstExec)
  })
})
