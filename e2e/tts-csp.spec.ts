import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * GH #77, the CSP half: the shipped policy decides whether read-aloud makes a
 * sound. WKWebView is lax about it, so every Mac here played fine while
 * WebView2's Chromium blocked every data:audio URL on the reporters' Windows.
 *
 * This spec loads the EXACT csp from tauri.conf.json into a Chromium page and
 * pins the contract the voice layer relies on:
 *   - a data:audio URL does not play (which is why synthesis must hand out
 *     blob URLs, never data URLs)
 *   - a blob URL plays (media-src blob:)
 *   - fetch() of a blob URL works (connect-src blob:, the codec-free Web
 *     Audio fallback for Windows N reads its bytes this way)
 */

const csp = (
  JSON.parse(readFileSync(join(here, '..', 'src-tauri', 'tauri.conf.json'), 'utf8')) as {
    app: { security: { csp: string } }
  }
).app.security.csp

test('the shipped CSP blocks data:audio and allows blob playback + blob fetch', async ({ page }) => {
  await page.setContent(
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}"><body></body>`,
  )

  const verdict = await page.evaluate(async () => {
    // A minimal valid 16-bit PCM wav (4 frames of silence, 22.05 kHz mono),
    // built in-page so both URL flavors carry identical bytes.
    const dataLen = 8
    const buf = new ArrayBuffer(44 + dataLen)
    const v = new DataView(buf)
    const w = (o: number, s: string) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
    }
    w(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); w(8, 'WAVE')
    w(12, 'fmt '); v.setUint32(16, 16, true)
    v.setUint16(20, 1, true); v.setUint16(22, 1, true)
    v.setUint32(24, 22050, true); v.setUint32(28, 44100, true)
    v.setUint16(32, 2, true); v.setUint16(34, 16, true)
    w(36, 'data'); v.setUint32(40, dataLen, true)
    const bytes = new Uint8Array(buf)

    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    const dataUrl = `data:audio/wav;base64,${btoa(bin)}`
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))

    const tryPlay = (url: string) =>
      new Promise<string>((resolve) => {
        const a = new Audio(url)
        a.muted = true
        a.onerror = () => resolve('error')
        a.play().then(() => resolve('playing'), (e: Error) => resolve(`rejected:${e.name}`))
        setTimeout(() => resolve('timeout'), 3000)
      })

    const dataPlay = await tryPlay(dataUrl)
    const blobPlay = await tryPlay(blobUrl)
    const blobFetch = await fetch(blobUrl).then(
      (r) => (r.ok ? 'ok' : `status:${r.status}`),
      (e: Error) => `rejected:${e.name}`,
    )
    return { dataPlay, blobPlay, blobFetch }
  })

  // The bug: a data URL under this policy never plays. If this ever flips to
  // 'playing', someone widened media-src — the blob conversion stays either way.
  expect(verdict.dataPlay).not.toBe('playing')
  // The fix: identical bytes as a blob URL play, and their fetch is allowed.
  expect(verdict.blobPlay).toBe('playing')
  expect(verdict.blobFetch).toBe('ok')
})
