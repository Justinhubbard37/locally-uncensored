import { describe, it, expect, vi, beforeEach } from 'vitest'

// The auto-download path lives inside the Tauri branch of checkForUpdate, which
// updateStore.test.ts cannot reach (it mocks isTauri to false to exercise the
// dev/GitHub path). Hence a second file with the real plugin mocked.
//
// Why this exists at all: on 2026-08-05 the in-app waitlist was still logging
// sign-ups from 2.5.5 and 2.5.6 builds, weeks after 2.5.7 shipped, on installs
// whose updater and signing key were both fine. People were not refusing the
// update, they were never getting as far as starting the download.

vi.mock('../../api/backend', () => ({
  isTauri: () => true,
  backendCall: vi.fn(),
  openExternal: vi.fn(),
}))

vi.mock('../../../package.json', () => ({ version: '2.0.0' }))

const updater = vi.hoisted(() => ({
  check: vi.fn(),
  downloads: 0,
}))

vi.mock('@tauri-apps/plugin-updater', () => ({ check: updater.check }))

import { useUpdateStore } from '../updateStore'

/** An Update handle that reports a complete download when asked. */
function fakeUpdate(version: string) {
  return {
    version,
    body: 'notes',
    download: vi.fn(async (cb: (e: unknown) => void) => {
      updater.downloads++
      cb({ event: 'Started', data: { contentLength: 100 } })
      cb({ event: 'Progress', data: { chunkLength: 100 } })
      cb({ event: 'Finished' })
    }),
    install: vi.fn(),
  }
}

/** checkForUpdate fires the download without awaiting it, on purpose: a 100 MB
 *  fetch must not block the check. Let those microtasks land. */
const settle = () => new Promise((r) => setTimeout(r, 0))

function reset(over: Record<string, unknown> = {}) {
  useUpdateStore.setState({
    currentVersion: '2.0.0',
    latestVersion: null,
    updateAvailable: false,
    releaseNotes: null,
    isChecking: false,
    lastChecked: null,
    dismissed: null,
    autoDownload: true,
    downloadStatus: 'idle',
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    errorMessage: null,
    ...over,
  })
}

beforeEach(() => {
  updater.check.mockReset()
  updater.downloads = 0
  reset()
})

describe('an update fetches itself', () => {
  it('downloads as soon as the check finds one', async () => {
    updater.check.mockResolvedValue(fakeUpdate('2.1.0'))

    await useUpdateStore.getState().checkForUpdate()
    await settle()

    expect(updater.downloads).toBe(1)
    expect(useUpdateStore.getState().downloadStatus).toBe('downloaded')
    expect(useUpdateStore.getState().latestVersion).toBe('2.1.0')
  })

  it('stays off when the user turned it off', async () => {
    reset({ autoDownload: false })
    updater.check.mockResolvedValue(fakeUpdate('2.1.0'))

    await useUpdateStore.getState().checkForUpdate()
    await settle()

    expect(updater.downloads).toBe(0)
    // The badge still offers the manual Download button.
    expect(useUpdateStore.getState().updateAvailable).toBe(true)
    expect(useUpdateStore.getState().downloadStatus).toBe('idle')
  })

  it('starts immediately when the user switches it on with one waiting', async () => {
    reset({ autoDownload: false })
    updater.check.mockResolvedValue(fakeUpdate('2.1.0'))
    await useUpdateStore.getState().checkForUpdate()
    await settle()
    expect(updater.downloads).toBe(0)

    useUpdateStore.getState().setAutoDownload(true)
    await settle()

    expect(updater.downloads).toBe(1)
  })
})

describe('the 6h re-check does not re-download', () => {
  it('leaves a finished download alone', async () => {
    updater.check.mockResolvedValue(fakeUpdate('2.1.0'))
    await useUpdateStore.getState().checkForUpdate()
    await settle()
    expect(updater.downloads).toBe(1)

    // The interval keeps firing for as long as the user stays on the old build.
    // Resetting downloadStatus here would pull the same 100 MB every 6 hours,
    // and would also blank a "Restart to update" badge back to "Download".
    await useUpdateStore.getState().checkForUpdate(true)
    await settle()
    await useUpdateStore.getState().checkForUpdate(true)
    await settle()

    expect(updater.downloads).toBe(1)
    expect(useUpdateStore.getState().downloadStatus).toBe('downloaded')
    expect(useUpdateStore.getState().downloadProgress).toBe(100)
  })

  it('does re-download when the target version actually changes', async () => {
    updater.check.mockResolvedValue(fakeUpdate('2.1.0'))
    await useUpdateStore.getState().checkForUpdate()
    await settle()

    // A newer release lands while the app is still open: what we hold on disk
    // is the wrong build now, so the state must reset and fetch again.
    updater.check.mockResolvedValue(fakeUpdate('2.2.0'))
    await useUpdateStore.getState().checkForUpdate(true)
    await settle()

    expect(updater.downloads).toBe(2)
    expect(useUpdateStore.getState().latestVersion).toBe('2.2.0')
    expect(useUpdateStore.getState().downloadStatus).toBe('downloaded')
  })

  it('does not restart a download that is still running', async () => {
    const update = fakeUpdate('2.1.0')
    updater.check.mockResolvedValue(update)
    reset({ downloadStatus: 'downloading', latestVersion: '2.1.0', updateAvailable: true })

    await useUpdateStore.getState().checkForUpdate(true)
    await settle()

    expect(updater.downloads).toBe(0)
  })
})

describe('a withdrawn release stops being advertised', () => {
  // Found on 2026-08-15 at the installed 2.6.5 build while checking that a
  // prerelease install is not offered the older Latest: with a version left in
  // the store, the Updates section showed "Latest Version v2.9.9" and the green
  // "You are on the latest version." at the same time. The branch that finds
  // nothing only cleared updateAvailable and left the version standing.
  it('forgets the version once the check comes back empty', async () => {
    updater.check.mockResolvedValue(fakeUpdate('2.1.0'))
    await useUpdateStore.getState().checkForUpdate()
    await settle()
    expect(useUpdateStore.getState().latestVersion).toBe('2.1.0')

    // The release is pulled: same endpoint, nothing newer than what runs here.
    updater.check.mockResolvedValue(null)
    await useUpdateStore.getState().checkForUpdate(true)
    await settle()

    expect(useUpdateStore.getState().updateAvailable).toBe(false)
    expect(useUpdateStore.getState().latestVersion).toBe(null)
    expect(useUpdateStore.getState().releaseNotes).toBe(null)
  })
})
