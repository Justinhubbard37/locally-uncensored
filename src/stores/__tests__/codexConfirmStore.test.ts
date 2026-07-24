import { describe, it, expect, beforeEach } from 'vitest'
import { useCodexConfirmStore } from '../codexConfirmStore'

// The gate used to be window.confirm, which blocks the whole webview and cannot
// be styled or dismissed with "stop asking". This store is the bridge that lets
// an in-app popup answer the same awaited boolean.

const req = (command: string, cloudReason = false) => ({
  toolName: 'shell_execute',
  command,
  cloudReason,
})

beforeEach(() => {
  useCodexConfirmStore.setState({ pending: null, resolve: null })
})

describe('codexConfirmStore', () => {
  it('parks the request and resolves true on Run', async () => {
    const p = useCodexConfirmStore.getState().ask(req('ls -la'))
    expect(useCodexConfirmStore.getState().pending?.command).toBe('ls -la')
    useCodexConfirmStore.getState().answer(true)
    await expect(p).resolves.toBe(true)
  })

  it('resolves false on No', async () => {
    const p = useCodexConfirmStore.getState().ask(req('rm -rf /'))
    useCodexConfirmStore.getState().answer(false)
    await expect(p).resolves.toBe(false)
  })

  it('clears the pending request once answered, so the popup closes', () => {
    void useCodexConfirmStore.getState().ask(req('echo hi'))
    useCodexConfirmStore.getState().answer(true)
    expect(useCodexConfirmStore.getState().pending).toBeNull()
    expect(useCodexConfirmStore.getState().resolve).toBeNull()
  })

  it('never strands a resolver when a second request arrives', async () => {
    // Two tools racing would otherwise leave the first awaiting forever, and
    // that tool call hangs with no visible cause. Deny the older one.
    const first = useCodexConfirmStore.getState().ask(req('first'))
    const second = useCodexConfirmStore.getState().ask(req('second'))
    await expect(first).resolves.toBe(false)
    expect(useCodexConfirmStore.getState().pending?.command).toBe('second')
    useCodexConfirmStore.getState().answer(true)
    await expect(second).resolves.toBe(true)
  })

  it('carries the cloud reason through, since it picks which setting to clear', () => {
    void useCodexConfirmStore.getState().ask(req('whoami', true))
    expect(useCodexConfirmStore.getState().pending?.cloudReason).toBe(true)
  })

  it('answering with nothing pending does not throw', () => {
    expect(() => useCodexConfirmStore.getState().answer(true)).not.toThrow()
  })
})
