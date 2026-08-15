import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCall = vi.fn()
const checkComfyConnection = vi.fn()

vi.mock('../backend', () => ({ backendCall: (...a: unknown[]) => backendCall(...a) }))
vi.mock('../comfyui', () => ({ checkComfyConnection: () => checkComfyConnection() }))

import { restartComfyForNewNodes } from '../comfy-restart'

/**
 * Der Fall stammt vom 15.08.2026 von der Testmaschine. ComfyUI lief dort nicht
 * als Kind von LU. `stop_comfyui` hat deshalb nichts beendet, der alte Prozess
 * hat weiter geantwortet, der neu gestartete kam nie an den Port, und die
 * Oberflaeche schickte den Nutzer in ein Startprotokoll, in dem der gesuchte
 * Fehler gar nicht stehen konnte.
 */
describe('Neustart fuer frisch installierte Knoten', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    backendCall.mockReset().mockResolvedValue(undefined)
    checkComfyConnection.mockReset()
  })

  const lauf = async (p: Promise<unknown>) => {
    const gefangen = p.then((r) => ({ ok: true, r }), (e: Error) => ({ ok: false, e: e.message }))
    await vi.runAllTimersAsync()
    return gefangen
  }

  it('ein fremdes ComfyUI wird benannt statt still uebergangen', async () => {
    checkComfyConnection.mockResolvedValue(true)
    const r = await lauf(restartComfyForNewNodes())
    expect(r).toMatchObject({ ok: false })
    expect((r as { e: string }).e).toContain('running outside LU')
    // Und vor allem: es wird kein zweiter Prozess danebengestartet.
    expect(backendCall.mock.calls.map((c) => c[0])).toEqual(['stop_comfyui'])
  })

  it('das eigene ComfyUI wird gestoppt und wieder gestartet', async () => {
    checkComfyConnection.mockResolvedValue(false)
    const r = await lauf(restartComfyForNewNodes())
    expect(r).toMatchObject({ ok: true })
    expect(backendCall.mock.calls.map((c) => c[0])).toEqual(['stop_comfyui', 'start_comfyui'])
  })

  it('ein langsamer Stopp ist kein fremder Prozess', async () => {
    // Zwei Runden lang antwortet der Port noch, dann ist er still.
    checkComfyConnection
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false)
    const r = await lauf(restartComfyForNewNodes())
    expect(r).toMatchObject({ ok: true })
    expect(backendCall.mock.calls.map((c) => c[0])).toEqual(['stop_comfyui', 'start_comfyui'])
  })

  it('ein Stopp, der gar nicht geht, haelt den Neustart nicht auf', async () => {
    backendCall.mockImplementation((cmd: string) =>
      cmd === 'stop_comfyui' ? Promise.reject(new Error('not running')) : Promise.resolve(undefined))
    checkComfyConnection.mockResolvedValue(false)
    const r = await lauf(restartComfyForNewNodes())
    expect(r).toMatchObject({ ok: true })
    expect(backendCall.mock.calls.map((c) => c[0])).toEqual(['stop_comfyui', 'start_comfyui'])
  })
})
