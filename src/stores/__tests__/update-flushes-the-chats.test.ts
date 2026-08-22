/**
 * DATA LOSS, aldrich_ironhart on 2.6.5 (Discord #general 18.08. 12:59 "has
 * anyone lost their chats after a restart??", 16:12 "My code chats are
 * vaporised", a coding chat around 230k tokens). sockenmonster on the same
 * build lost nothing, weeks old chats included, so this is not a plain
 * regression in how LU writes: the persistence layer is unchanged between
 * 2.6.4 and 2.6.5.
 *
 * What IS specific to the update is the handover. installAndRestart calls
 * install(), which does not return, the installer takes the process down. The
 * chat store persists through coalescedJSONStorage, whose window closes 250 ms
 * after the last change, so a multi megabyte IndexedDB put can be in flight at
 * exactly that moment. A LevelDB killed mid write is the most plausible way to
 * end up with Chromium discarding the whole database on the next start, and
 * the bigger the history the wider the window.
 *
 * So the store flushes and goes quiet before it hands over. This pins the
 * ORDER, which is the entire point: flushing after install() has started would
 * be the same bug with extra steps.
 *
 * Run: npx vitest run src/stores/__tests__/update-flushes-the-chats.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: string[] = []

vi.mock('../../api/backend', () => ({
  isTauri: () => true,
  openExternal: vi.fn(),
  backendCall: vi.fn(async (cmd: string) => {
    calls.push(`backend:${cmd}`)
    return null
  }),
}))

vi.mock('../../api/engine', () => ({
  stopBundledEngine: vi.fn(async () => { calls.push('stop:engine') }),
  stopBundledEmbed: vi.fn(async () => { calls.push('stop:embed') }),
}))

const flushChatPersist = vi.fn(async () => { calls.push('flush:chat') })
const flushStagedPersist = vi.fn(async () => { calls.push('flush:staged') })

vi.mock('../chatStore', () => ({ flushChatPersist: () => flushChatPersist() }))
vi.mock('../stagedChangesStore', () => ({ flushStagedPersist: () => flushStagedPersist() }))

vi.mock('../../../package.json', () => ({ version: '2.6.5' }))

const install = vi.fn(async () => { calls.push('install') })

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => ({ version: '2.6.6', body: 'notes', install, download: vi.fn() })),
}))

import { useUpdateStore } from '../updateStore'

async function armPendingUpdate() {
  await useUpdateStore.getState().checkForUpdate(true)
}

describe('an update puts the chats on disk before it hands the process over', () => {
  beforeEach(() => {
    calls.length = 0
    install.mockClear()
    flushChatPersist.mockClear()
    flushStagedPersist.mockClear()
    flushChatPersist.mockImplementation(async () => { calls.push('flush:chat') })
    useUpdateStore.setState({
      downloadStatus: 'downloaded',
      autoDownload: false,
      lastChecked: null,
      latestVersion: null,
      updateAvailable: false,
      errorMessage: null,
    })
  })

  it('flushes both coalesced stores before install()', async () => {
    await armPendingUpdate()
    calls.length = 0

    await useUpdateStore.getState().installAndRestart()

    expect(calls).toContain('flush:chat')
    expect(calls).toContain('flush:staged')
    expect(calls.indexOf('flush:chat')).toBeLessThan(calls.indexOf('install'))
    expect(calls.indexOf('flush:staged')).toBeLessThan(calls.indexOf('install'))
  })

  it('NEGATIVE CONTROL: freeing the sidecars was never a flush', async () => {
    // What the path did before: two engine stops and straight into install().
    // Neither of those touches the persistence layer, so a write started
    // 249 ms earlier was still in flight when the installer arrived.
    await armPendingUpdate()
    calls.length = 0

    await useUpdateStore.getState().installAndRestart()

    const before = calls.slice(0, calls.indexOf('install'))
    expect(before).toContain('stop:engine')
    expect(before).toContain('stop:embed')
    // The old prefix was exactly those two, and that is what this adds to.
    expect(before.filter((c) => c.startsWith('flush:'))).toHaveLength(2)
  })

  it('the pause after the flush is real, not zero', async () => {
    // The flush resolves when the put has landed. What the storage engine
    // does with its own log after a commit is not something a page can await,
    // so there is a deliberate quiet moment on top.
    await armPendingUpdate()
    calls.length = 0

    const started = Date.now()
    await useUpdateStore.getState().installAndRestart()
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
  })

  it('a flush that fails does not become the reason the update never happens', async () => {
    // Same stance as the sidecar stops: best effort, the installer has its own
    // recovery, and refusing to update would be the worse failure.
    flushChatPersist.mockRejectedValueOnce(new Error('idb gone'))

    await armPendingUpdate()
    calls.length = 0

    await useUpdateStore.getState().installAndRestart()

    expect(install).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().downloadStatus).not.toBe('error')
  })
})
