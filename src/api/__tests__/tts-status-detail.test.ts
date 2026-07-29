/**
 * `tts_status` answers three different questions — is the piper package
 * importable, is a complete voice on disk, and is the combination usable. The
 * frontend collapsed all three into one boolean, so read-aloud's fallback
 * notice told a user who had never installed Piper that Piper "is installed
 * but not responding" — pointing them at a fault that did not exist.
 *
 * These lock the sub-flags surviving the probe, which is what the notice
 * words itself from.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCall = vi.fn()
vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...a),
  isTauri: () => true,
}))

import { initTtsCheck, recheckTtsAvailable, getLastTtsStatus } from '../voice'

beforeEach(() => {
  backendCall.mockReset()
})

describe('tts status detail', () => {
  it('keeps "piper missing" distinguishable from "voice missing"', async () => {
    backendCall.mockResolvedValueOnce({ available: false, piper: false, voice: false })
    await recheckTtsAvailable('de_DE-thorsten-medium')
    expect(getLastTtsStatus()).toMatchObject({ piper: false })

    backendCall.mockResolvedValueOnce({ available: false, piper: true, voice: false })
    await recheckTtsAvailable('de_DE-thorsten-medium')
    const st = getLastTtsStatus()
    expect(st.piper).toBe(true)
    expect(st.voice).toBe(false)
  })

  it('reports the ready case as available with both sub-flags set', async () => {
    backendCall.mockResolvedValueOnce({ available: true, piper: true, voice: true })
    expect(await recheckTtsAvailable('de_DE-thorsten-medium')).toBe(true)
    expect(getLastTtsStatus()).toEqual({ available: true, piper: true, voice: true })
  })

  it('falls back to "nothing known" when the probe throws', async () => {
    // A thrown probe must not leave the previous run's sub-flags standing, or
    // the notice would explain a state that is no longer being observed.
    backendCall.mockResolvedValueOnce({ available: true, piper: true, voice: true })
    await recheckTtsAvailable('a')
    backendCall.mockRejectedValueOnce(new Error('backend gone'))
    await recheckTtsAvailable('b')
    expect(getLastTtsStatus()).toEqual({ available: false })
  })

  it('does not re-probe once a positive result is cached for the same voice', async () => {
    backendCall.mockResolvedValue({ available: true, piper: true, voice: true })
    await recheckTtsAvailable('same')
    const callsAfterFirst = backendCall.mock.calls.length
    await initTtsCheck('same')
    expect(backendCall.mock.calls.length).toBe(callsAfterFirst)
  })
})
