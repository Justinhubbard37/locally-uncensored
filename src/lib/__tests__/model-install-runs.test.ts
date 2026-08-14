/**
 * A bundle install must not lose its owner.
 *
 * Found by the review of the C8 fix (2026-08-14). Stage picks the install card
 * only while the lane list is empty and nothing is rendering, so the card
 * unmounts the moment either changes. The run kept going with no status line,
 * no Cancel button and no place for its error, and the user read the vanished
 * card as "setup finished".
 *
 * Two properties matter and both are pinned here: the run survives the card,
 * and one lane can never have two installs writing the same file.
 *
 * Run: npx vitest run src/lib/__tests__/model-install-runs.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  startInstallRun, getInstallRun, isInstalling, cancelInstallRun, clearInstallRun,
  subscribeInstallRuns, resetInstallRuns,
} from '../model-install-runs'

const flush = () => new Promise((r) => setTimeout(r, 0))

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => resetInstallRuns())

describe('the run belongs to the lane, not to the card', () => {
  it('status keeps arriving after the card that started it is gone', async () => {
    const d = deferred()
    let publish!: (s: string) => void
    startInstallRun('lipsync', (onStatus) => { publish = onStatus; return d.promise })

    publish('Downloading 1 of 3…')
    expect(getInstallRun('lipsync').status).toBe('Downloading 1 of 3…')

    // The card unmounts here. Nothing about the run changes.
    publish('Waiting for ComfyUI to list the new files… 12s')
    expect(getInstallRun('lipsync').status).toBe('Waiting for ComfyUI to list the new files… 12s')
    expect(isInstalling('lipsync')).toBe(true)

    d.resolve()
    await flush()
    expect(isInstalling('lipsync')).toBe(false)
  })

  it('an error survives the swap and is there when the card comes back', async () => {
    const d = deferred()
    startInstallRun('lipsync', () => d.promise)
    d.reject(new Error('ComfyUI still does not list Wan2.2-S2V-14B-Q4_K_M.gguf'))
    await flush()

    const run = getInstallRun('lipsync')
    expect(run.running).toBe(false)
    expect(run.err).toContain('still does not list')
  })

  it('dismissing the error puts the lane back to offering the install', async () => {
    const d = deferred()
    startInstallRun('video', () => d.promise)
    d.reject(new Error('boom'))
    await flush()
    clearInstallRun('video')
    expect(getInstallRun('video')).toEqual({ status: '', err: null, running: false })
  })
})

describe('one lane, one install', () => {
  it('a second start while one is running is ignored, not queued', async () => {
    const first = deferred()
    const second = vi.fn()
    startInstallRun('image', () => first.promise)
    startInstallRun('image', () => { second(); return Promise.resolve() })
    expect(second).not.toHaveBeenCalled()
    first.resolve()
    await flush()
  })

  it('after it finishes, the lane can be installed again', async () => {
    const first = deferred()
    startInstallRun('image', () => first.promise)
    first.resolve()
    await flush()

    const again = vi.fn(() => Promise.resolve())
    startInstallRun('image', again)
    expect(again).toHaveBeenCalledTimes(1)
  })

  it('a dismissed error does not block the retry either', async () => {
    const d = deferred()
    startInstallRun('audio', () => d.promise)
    d.reject(new Error('nope'))
    await flush()
    clearInstallRun('audio')

    const again = vi.fn(() => Promise.resolve())
    startInstallRun('audio', again)
    expect(again).toHaveBeenCalledTimes(1)
  })
})

describe('cancel and subscription', () => {
  it('cancel aborts the signal the runner was handed', () => {
    let seen: AbortSignal | undefined
    startInstallRun('motion', (_s, signal) => { seen = signal; return new Promise<void>(() => {}) })
    expect(seen?.aborted).toBe(false)
    cancelInstallRun('motion')
    expect(seen?.aborted).toBe(true)
  })

  it('subscribers hear every change, that is what re-renders the card', () => {
    const seen = vi.fn()
    const off = subscribeInstallRuns(seen)
    let publish!: (s: string) => void
    startInstallRun('video', (onStatus) => { publish = onStatus; return new Promise<void>(() => {}) })
    publish('one')
    publish('two')
    expect(seen.mock.calls.length).toBeGreaterThanOrEqual(3)
    off()
    publish('three')
    const after = seen.mock.calls.length
    publish('four')
    expect(seen.mock.calls.length).toBe(after)
  })

  it('an untouched lane reads as idle, never undefined', () => {
    expect(getInstallRun('lipsync')).toEqual({ status: '', err: null, running: false })
    expect(isInstalling('lipsync')).toBe(false)
  })
})
