/**
 * The update path has to free our own engine before the installer runs.
 *
 * C4 came from aldrich_ironhart on 2026-08-10: the update stopped at "Error
 * opening file for writing: llama-server.exe" with Abort, Retry, Ignore.
 * Windows locks a running image against writes and that file lives in the
 * install directory. The fix went into the NSIS hook, and on 2026-08-15 the
 * installed build was measured to really take the NSIS lane: the exe carries
 * `__TAURI_BUNDLE_TYPE_VAR_NSS`, so the updater asks for `windows-x86_64-nsis`
 * first, which our latest.json carries.
 *
 * That covers the .exe. It does not cover the .msi, which our own release notes
 * offer for system-wide installs: a machine that installed it reports the MSI
 * bundle type, gets the MSI update, and WiX has no hook of ours. The `exit_app`
 * in this store is no substitute either, because it runs AFTER install() has
 * handed over to the installer.
 *
 * So the app stops its own sidecars first, on every lane. This test pins the
 * ORDER, which is the whole point: stopping them after the installer starts
 * would be the same bug with extra steps.
 *
 * Run: npx vitest run src/stores/__tests__/update-frees-the-sidecar.test.ts
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
  stopBundledEngine: vi.fn(async () => {
    calls.push('stop:engine')
  }),
  stopBundledEmbed: vi.fn(async () => {
    calls.push('stop:embed')
  }),
}))

vi.mock('../../../package.json', () => ({ version: '2.6.5' }))

const install = vi.fn(async () => {
  calls.push('install')
})

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => ({ version: '2.6.6', body: 'notes', install, download: vi.fn() })),
}))

import { useUpdateStore } from '../updateStore'

async function armPendingUpdate() {
  // The Update handle only exists after a successful check.
  await useUpdateStore.getState().checkForUpdate(true)
}

describe('installing an update frees our own engine first', () => {
  beforeEach(() => {
    calls.length = 0
    install.mockClear()
    useUpdateStore.setState({
      downloadStatus: 'downloaded',
      autoDownload: false,
      lastChecked: null,
      latestVersion: null,
      updateAvailable: false,
      errorMessage: null,
    })
  })

  it('stops both sidecars before handing over to the installer', async () => {
    await armPendingUpdate()
    calls.length = 0

    await useUpdateStore.getState().installAndRestart()

    expect(calls).toContain('stop:engine')
    expect(calls).toContain('stop:embed')
    expect(calls.indexOf('stop:engine')).toBeLessThan(calls.indexOf('install'))
    expect(calls.indexOf('stop:embed')).toBeLessThan(calls.indexOf('install'))
    // And the exit still comes last, after the installer has been handed the job.
    expect(calls.indexOf('install')).toBeLessThan(calls.indexOf('backend:exit_app'))
  })

  it('installs anyway when a sidecar refuses to stop', async () => {
    // A stop that throws must not become the reason the update never happens:
    // the installer has its own recovery, this is the belt on top of it.
    const engine = await import('../../api/engine')
    vi.mocked(engine.stopBundledEngine).mockRejectedValueOnce(new Error('busy'))

    await armPendingUpdate()
    calls.length = 0

    await useUpdateStore.getState().installAndRestart()

    expect(install).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().downloadStatus).not.toBe('error')
  })
})
