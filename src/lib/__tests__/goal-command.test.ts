import { describe, it, expect, beforeEach, vi } from 'vitest'

// zustand/persist needs storage; vitest runs on `node`.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => { store.clear() },
})

import { applyGoalCommand } from '../goal-command'
import { useAgentGoalStore, renderGoalSection, MAX_GOAL_LENGTH } from '../../stores/agentGoalStore'

const CONV = 'conv-1'

beforeEach(() => {
  store.clear()
  useAgentGoalStore.setState({ goals: {} })
})

describe('/goal', () => {
  it('sets an objective and confirms it', () => {
    const r = applyGoalCommand(CONV, 'ship 2.5.9 with no regressions')
    expect(r.action).toBe('set')
    expect(r.message).toContain('ship 2.5.9 with no regressions')
    expect(useAgentGoalStore.getState().getGoal(CONV)?.text).toBe('ship 2.5.9 with no regressions')
  })

  it('reads the current goal back with no arguments', () => {
    applyGoalCommand(CONV, 'fix the flaky test')
    const r = applyGoalCommand(CONV, '')
    expect(r.action).toBe('read')
    expect(r.message).toContain('fix the flaky test')
  })

  it('says so when there is nothing to read', () => {
    const r = applyGoalCommand(CONV, '')
    expect(r.action).toBe('read')
    expect(r.message).toContain('No goal set')
  })

  it('clears on clear / off / none / reset', () => {
    for (const word of ['clear', 'off', 'none', 'reset']) {
      applyGoalCommand(CONV, 'something')
      const r = applyGoalCommand(CONV, word)
      expect(r.action, word).toBe('clear')
      expect(useAgentGoalStore.getState().getGoal(CONV)).toBeNull()
    }
  })

  it('clearing nothing is not reported as a change', () => {
    expect(applyGoalCommand(CONV, 'clear').action).toBe('noop')
  })

  it('replaces rather than appends', () => {
    applyGoalCommand(CONV, 'first')
    applyGoalCommand(CONV, 'second')
    expect(useAgentGoalStore.getState().getGoal(CONV)?.text).toBe('second')
  })

  it('keeps goals separate per conversation', () => {
    applyGoalCommand('a', 'goal A')
    applyGoalCommand('b', 'goal B')
    expect(useAgentGoalStore.getState().getGoal('a')?.text).toBe('goal A')
    expect(useAgentGoalStore.getState().getGoal('b')?.text).toBe('goal B')
  })

  it('truncates a runaway goal and says it did', () => {
    // A goal rides in EVERY later prompt, so an unbounded one quietly eats the
    // context window it was meant to help focus.
    const long = 'x'.repeat(MAX_GOAL_LENGTH + 200)
    const r = applyGoalCommand(CONV, long)
    expect(useAgentGoalStore.getState().getGoal(CONV)!.text.length).toBe(MAX_GOAL_LENGTH)
    expect(r.message).toContain('Trimmed')
  })
})

describe('renderGoalSection', () => {
  it('is empty when nothing is set, so callers can concatenate blindly', () => {
    expect(renderGoalSection(null)).toBe('')
    expect(renderGoalSection({ text: '', setAt: 0 })).toBe('')
  })

  it('carries the goal text and tells the model not to parrot it', () => {
    const out = renderGoalSection({ text: 'keep the build green', setAt: 0 })
    expect(out).toContain('keep the build green')
    expect(out).toContain('Do not announce the goal back to the user every turn')
  })

  it('lets an off-goal request through instead of redirecting it', () => {
    // A north star that hijacks unrelated questions is worse than no north star.
    expect(renderGoalSection({ text: 'g', setAt: 0 })).toContain('do the request anyway')
  })
})
