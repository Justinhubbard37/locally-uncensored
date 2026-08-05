/**
 * Audit A4 — Stop while the shell-confirm dialog is open must resolve the
 * awaited approval as "no" and take the dialog down. Before this, the promise
 * only ever resolved on a click, so the run's finally never ran and the chat
 * stayed wedged with the typing dots on.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useCodexConfirmStore } from '../codexConfirmStore'

const req = { toolName: 'shell_execute', command: 'rm -rf build', cloudReason: false }

beforeEach(() => {
  useCodexConfirmStore.setState({ pending: null, resolve: null })
})

describe('codexConfirmStore.ask with an abort signal', () => {
  it('resolves false and clears the dialog when the signal fires', async () => {
    const ctrl = new AbortController()
    const p = useCodexConfirmStore.getState().ask(req, ctrl.signal)
    expect(useCodexConfirmStore.getState().pending).not.toBeNull()
    ctrl.abort()
    await expect(p).resolves.toBe(false)
    expect(useCodexConfirmStore.getState().pending).toBeNull()
    expect(useCodexConfirmStore.getState().resolve).toBeNull()
  })

  it('resolves false immediately on an already-aborted signal', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(useCodexConfirmStore.getState().ask(req, ctrl.signal)).resolves.toBe(false)
    expect(useCodexConfirmStore.getState().pending).toBeNull()
  })

  it('a click still wins over a later abort', async () => {
    const ctrl = new AbortController()
    const p = useCodexConfirmStore.getState().ask(req, ctrl.signal)
    useCodexConfirmStore.getState().answer(true)
    ctrl.abort()
    await expect(p).resolves.toBe(true)
  })

  it('an abort of request A does not clear a newer request B', async () => {
    const a = new AbortController()
    const pA = useCodexConfirmStore.getState().ask(req, a.signal)
    const pB = useCodexConfirmStore.getState().ask({ ...req, command: 'npm test' })
    // B replaced A, so A already resolved false; aborting A now must not
    // touch B's open dialog.
    a.abort()
    await expect(pA).resolves.toBe(false)
    expect(useCodexConfirmStore.getState().pending?.command).toBe('npm test')
    useCodexConfirmStore.getState().answer(true)
    await expect(pB).resolves.toBe(true)
  })
})
