/**
 * The backend selector never opens over a running run (G25, R17c witness
 * 2026-08-07): detection resolved seconds after startup, the agent run was
 * already streaming, and the "Multiple backends running" modal stood over the
 * chat for the rest of the 20 minute run.
 *
 * Run: npx vitest run src/lib/__tests__/run-idle.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { anyRunActive, whenRunsIdle } from '../run-idle'
import { useGenerationStore } from '../../stores/generationStore'
import { useCodexStore } from '../../stores/codexStore'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

describe('anyRunActive', () => {
  it('a generating chat/agent conversation counts as active', () => {
    expect(anyRunActive({ 'conv-1': true }, {})).toBe(true)
  })

  it('a running coding thread counts as active', () => {
    expect(anyRunActive({}, { 'conv-1': { status: 'running' } })).toBe(true)
  })

  it('NEGATIVE CONTROL: idle and errored threads do not block', () => {
    expect(anyRunActive({}, {})).toBe(false)
    expect(anyRunActive({}, { a: { status: 'idle' }, b: { status: 'error' } })).toBe(false)
  })
})

describe('whenRunsIdle against the real stores', () => {
  beforeEach(() => {
    // Reset both stores to a clean idle state.
    useGenerationStore.setState({ generating: {}, aborters: {} })
    useCodexStore.setState({ threads: {} })
  })

  it('idle → shows immediately', () => {
    let shown = 0
    whenRunsIdle(() => shown++)
    expect(shown).toBe(1)
  })

  it('R17c: an active agent run defers the dialog until the run ends', () => {
    useGenerationStore.getState().setGenerating('conv-1', true)
    let shown = 0
    whenRunsIdle(() => shown++)
    expect(shown).toBe(0)
    useGenerationStore.getState().setGenerating('conv-1', false)
    expect(shown).toBe(1)
  })

  it('a coding run defers it too, and it fires exactly once', () => {
    useCodexStore.getState().initThread('conv-c', '/tmp')
    useCodexStore.getState().setThreadStatus('conv-c', 'running')
    let shown = 0
    whenRunsIdle(() => shown++)
    expect(shown).toBe(0)
    useCodexStore.getState().setThreadStatus('conv-c', 'idle')
    expect(shown).toBe(1)
    // Further store churn must not re-fire the deferred show.
    useCodexStore.getState().setThreadStatus('conv-c', 'running')
    useCodexStore.getState().setThreadStatus('conv-c', 'idle')
    expect(shown).toBe(1)
  })

  it('waits for BOTH surfaces when both are busy', () => {
    useGenerationStore.getState().setGenerating('conv-1', true)
    useCodexStore.getState().initThread('conv-c', '/tmp')
    useCodexStore.getState().setThreadStatus('conv-c', 'running')
    let shown = 0
    whenRunsIdle(() => shown++)
    useGenerationStore.getState().setGenerating('conv-1', false)
    expect(shown).toBe(0)
    useCodexStore.getState().setThreadStatus('conv-c', 'idle')
    expect(shown).toBe(1)
  })

  it('NEGATIVE CONTROL: cancel withdraws a deferred show without firing it', () => {
    useGenerationStore.getState().setGenerating('conv-1', true)
    let shown = 0
    const cancel = whenRunsIdle(() => shown++)
    cancel()
    useGenerationStore.getState().setGenerating('conv-1', false)
    expect(shown).toBe(0)
  })
})

describe('wiring in AppShell', () => {
  const shell = read('../../components/layout/AppShell.tsx')

  it('the selector opens through the idle gate, never directly', () => {
    expect(shell).toContain('whenRunsIdle(() => {')
    const gated = shell.indexOf('whenRunsIdle(() => {')
    expect(shell.indexOf('setShowSelector(true)', gated)).toBeGreaterThan(gated)
  })

  it('NEGATIVE CONTROL: closing the dialog stays an immediate action', () => {
    expect(shell).toContain('onClose={() => setShowSelector(false)}')
  })
})
