import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { base64ToBlobUrl } from '../voice'

// GH #77, round two: the wav was fine, the URL was not. A data:audio URL is
// blocked by our own CSP (media-src allows blob: only), and the Web Audio
// fallback fetch()ing that data URL is blocked by connect-src the same way.
// WKWebView shrugs the policy off, WebView2's Chromium enforces it, which is
// why read-aloud worked on every Mac here and on no reporter's Windows. So no
// synthesis path may ever hand out a data: URL again, and the CSP must allow
// fetching our own blobs for the codec-free fallback.

describe('base64ToBlobUrl', () => {
  afterEach(() => vi.restoreAllMocks())

  it('decodes base64 into a Blob of the declared mime and returns its object URL', () => {
    const bytes = new Uint8Array([82, 73, 70, 70, 0, 255]) // "RIFF" + binary tail
    const b64 = btoa(String.fromCharCode(...bytes))

    let captured: Blob | undefined
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      captured = b as Blob
      return 'blob:mock/1'
    })

    expect(base64ToBlobUrl(b64, 'audio/wav')).toBe('blob:mock/1')
    expect(captured?.type).toBe('audio/wav')
    expect(captured?.size).toBe(bytes.length)
  })

  it('round-trips the exact bytes', async () => {
    const bytes = new Uint8Array(256).map((_, i) => i)
    const b64 = btoa(String.fromCharCode(...bytes))

    let captured: Blob | undefined
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      captured = b as Blob
      return 'blob:mock/2'
    })

    base64ToBlobUrl(b64, 'audio/wav')
    expect(new Uint8Array(await captured!.arrayBuffer())).toEqual(bytes)
  })
})

describe('no synthesis path builds a data: URL', () => {
  it('voice.ts no longer builds a data: URL from synthesis output', () => {
    const src = readFileSync(new URL('../voice.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/`data:/)
  })
})

describe('the CSP carries the fix', () => {
  const csp = (
    JSON.parse(
      readFileSync(new URL('../../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    ) as { app: { security: { csp: string } } }
  ).app.security.csp

  it('media-src allows blob playback', () => {
    expect(csp).toMatch(/media-src[^;]*blob:/)
  })

  it('connect-src allows fetching our own blobs (the Web Audio fallback)', () => {
    expect(csp).toMatch(/connect-src[^;]*blob:/)
  })

  it('connect-src does not open data: (only blob is needed)', () => {
    expect(csp).not.toMatch(/connect-src[^;]*data:/)
  })
})
