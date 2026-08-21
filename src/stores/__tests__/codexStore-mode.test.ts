/**
 * The per-conversation mode slice (plan 2.6.6, C1 + R1 DOWNGRADE-KONTRAKT).
 *
 * Two things are load-bearing and both have a price:
 *   - a pick made while a run is in flight must NOT change the running turn,
 *     it parks and applies at the next send (that is what the dropdown says),
 *   - the persist shape stays additive at version 0, because the D1 A/B has a
 *     2.6.5 build and a 2.6.6 build sharing one WebView profile and zustand
 *     throws the whole persisted state away on a version mismatch.
 *
 * Run: npx vitest run src/stores/__tests__/codexStore-mode.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'

// zustand/persist reads window.localStorage; the vitest env is 'node'. Assigned
// before the store import below, which is why that import is not hoisted to the
// top of the file.
const backing = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = globalThis
globalThis.localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() { return backing.size },
} as Storage

const { useCodexStore } = await import('../codexStore')

const KEY = 'locally-uncensored-codex'

beforeEach(() => {
  localStorage.clear()
  useCodexStore.setState({
    modeByConversation: {},
    parkedModeByConversation: {},
    prePlanModeByConversation: {},
    planApprovalByConversation: {},
    workingDirectory: '',
  })
})

describe('resolution: the conversation first, then the global default', () => {
  it('uses the conversation mode when it has one', () => {
    useCodexStore.getState().chooseCodexMode('x', 'bypass', false)
    expect(useCodexStore.getState().codexModeFor('x', 'ask')).toBe('bypass')
  })

  it('falls back to the global default for a conversation that never picked', () => {
    expect(useCodexStore.getState().codexModeFor('fresh', 'plan')).toBe('plan')
  })

  it('a pick in X leaves Y on the default: the modes do not leak sideways', () => {
    useCodexStore.getState().chooseCodexMode('X', 'bypass', false)
    expect(useCodexStore.getState().codexModeFor('Y', 'ask')).toBe('ask')
    // Negative control: a global write would have moved Y too.
    expect(useCodexStore.getState().modeByConversation.Y).toBeUndefined()
  })
})

describe('a switch during a run parks and applies at the next send', () => {
  it('does not touch the running turn', () => {
    useCodexStore.getState().chooseCodexMode('x', 'ask', false)
    useCodexStore.getState().chooseCodexMode('x', 'bypass', true)
    expect(useCodexStore.getState().codexModeFor('x', 'ask')).toBe('ask')
    expect(useCodexStore.getState().parkedModeByConversation.x).toBe('bypass')
  })

  it('the next send applies it and clears the park', () => {
    useCodexStore.getState().chooseCodexMode('x', 'ask', false)
    useCodexStore.getState().chooseCodexMode('x', 'bypass', true)
    useCodexStore.getState().applyParkedMode('x')
    expect(useCodexStore.getState().codexModeFor('x', 'ask')).toBe('bypass')
    expect(useCodexStore.getState().parkedModeByConversation.x).toBeUndefined()
  })

  it('negative control: applying with nothing parked changes nothing', () => {
    useCodexStore.getState().chooseCodexMode('x', 'ask', false)
    useCodexStore.getState().applyParkedMode('x')
    useCodexStore.getState().applyParkedMode('x')
    expect(useCodexStore.getState().codexModeFor('x', 'ask')).toBe('ask')
  })
})

describe('the mode from before Plan mode is remembered', () => {
  it('records the pre-plan mode on the way in', () => {
    useCodexStore.getState().chooseCodexMode('x', 'bypass', false)
    useCodexStore.getState().chooseCodexMode('x', 'plan', false)
    expect(useCodexStore.getState().prePlanModeByConversation.x).toBe('bypass')
  })

  it('records it when the plan pick was parked during a run', () => {
    useCodexStore.getState().chooseCodexMode('x', 'ask', false)
    useCodexStore.getState().chooseCodexMode('x', 'plan', true)
    useCodexStore.getState().applyParkedMode('x')
    expect(useCodexStore.getState().prePlanModeByConversation.x).toBe('ask')
  })

  it('a conversation that started in plan mode has nothing to inherit', () => {
    useCodexStore.getState().chooseCodexMode('x', 'plan', false)
    expect(useCodexStore.getState().prePlanModeByConversation.x).toBeUndefined()
  })

  it('plan to plan does not overwrite what came before', () => {
    useCodexStore.getState().chooseCodexMode('x', 'ask', false)
    useCodexStore.getState().chooseCodexMode('x', 'plan', false)
    useCodexStore.getState().chooseCodexMode('x', 'plan', false)
    expect(useCodexStore.getState().prePlanModeByConversation.x).toBe('ask')
  })
})

describe('the plan approval card', () => {
  it('is set and cleared per conversation', () => {
    useCodexStore.getState().setPlanApproval('x', { planText: '## Plan\n1. do it', messageId: 'm1', createdAt: 1 })
    expect(useCodexStore.getState().planApprovalByConversation.x?.planText).toContain('## Plan')
    expect(useCodexStore.getState().planApprovalByConversation.y).toBeUndefined()
    useCodexStore.getState().setPlanApproval('x', null)
    expect(useCodexStore.getState().planApprovalByConversation.x).toBeUndefined()
  })
})

describe('R1 DOWNGRADE-KONTRAKT: the persist shape stays additive at version 0', () => {
  const persisted = () => JSON.parse(localStorage.getItem(KEY) ?? '{}')

  it('writes the conversation modes next to the working directory and nothing else', () => {
    useCodexStore.getState().setWorkingDirectory('/repo')
    useCodexStore.getState().chooseCodexMode('x', 'plan', false)
    const raw = persisted()
    expect(Object.keys(raw.state).sort()).toEqual(['modeByConversation', 'workingDirectory'])
    expect(raw.state.modeByConversation).toEqual({ x: 'plan' })
    expect(raw.state.workingDirectory).toBe('/repo')
  })

  it('leaves the store version at 0, so a 2.6.5 build still reads this file', () => {
    useCodexStore.getState().setWorkingDirectory('/repo')
    // zustand writes `version: 0` explicitly, or omits it on the default.
    expect(persisted().version ?? 0).toBe(0)
  })

  it('the transient halves never reach the disk', () => {
    useCodexStore.getState().chooseCodexMode('x', 'plan', true)
    useCodexStore.getState().setPlanApproval('x', { planText: 'p', messageId: 'm', createdAt: 1 })
    const state = persisted().state ?? {}
    expect(state.parkedModeByConversation).toBeUndefined()
    expect(state.prePlanModeByConversation).toBeUndefined()
    expect(state.planApprovalByConversation).toBeUndefined()
    // Negative control: the key that IS meant to persist is there.
    expect(state).toHaveProperty('modeByConversation')
  })

  it('a downgrade that drops the key costs only the conversation modes', () => {
    // What a 2.6.5 build writes back: it knows workingDirectory and nothing else.
    localStorage.setItem(KEY, JSON.stringify({ state: { workingDirectory: '/repo' }, version: 0 }))
    useCodexStore.setState({ modeByConversation: {} })
    expect(useCodexStore.getState().codexModeFor('x', 'bypass')).toBe('bypass')
  })
})
