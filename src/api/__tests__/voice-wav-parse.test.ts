import { describe, it, expect } from 'vitest'
import { parseWavPcm } from '../voice'

// The codec-free playback fallback (GH #77) stands on this parser: a Windows
// N edition plays nothing through HTMLAudioElement, so the wav bytes must
// decode by hand. Build real RIFF files in-memory and walk every branch.

function wav16(opts: { sampleRate?: number; channels?: number; frames?: number } = {}) {
  const { sampleRate = 22050, channels = 1, frames = 4 } = opts
  const dataLen = frames * channels * 2
  const buf = new ArrayBuffer(44 + dataLen)
  const v = new DataView(buf)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); w(8, 'WAVE')
  w(12, 'fmt '); v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * channels * 2, true)
  v.setUint16(32, channels * 2, true)
  v.setUint16(34, 16, true)
  w(36, 'data'); v.setUint32(40, dataLen, true)
  return { buf, view: v, dataAt: 44 }
}

describe('parseWavPcm', () => {
  it('decodes the wav piper writes: 16-bit mono PCM', () => {
    const { buf, view, dataAt } = wav16({ frames: 3 })
    view.setInt16(dataAt, 32767, true)
    view.setInt16(dataAt + 2, -32768, true)
    view.setInt16(dataAt + 4, 0, true)
    const out = parseWavPcm(buf)!
    expect(out.sampleRate).toBe(22050)
    expect(out.channels).toHaveLength(1)
    expect(out.channels[0][0]).toBeCloseTo(1, 3)
    expect(out.channels[0][1]).toBe(-1)
    expect(out.channels[0][2]).toBe(0)
  })

  it('deinterleaves stereo frames into separate channels', () => {
    const { buf, view, dataAt } = wav16({ channels: 2, frames: 2 })
    view.setInt16(dataAt, 16384, true)      // L0
    view.setInt16(dataAt + 2, -16384, true) // R0
    view.setInt16(dataAt + 4, 8192, true)   // L1
    view.setInt16(dataAt + 6, -8192, true)  // R1
    const out = parseWavPcm(buf)!
    expect(out.channels).toHaveLength(2)
    expect(out.channels[0][0]).toBeCloseTo(0.5, 3)
    expect(out.channels[1][0]).toBeCloseTo(-0.5, 3)
    expect(out.channels[0][1]).toBeCloseTo(0.25, 3)
  })

  it('refuses what it cannot decode instead of guessing', () => {
    expect(parseWavPcm(new ArrayBuffer(10))).toBeNull()
    // mp3 magic bytes are not RIFF
    const mp3 = new Uint8Array(64); mp3[0] = 0xff; mp3[1] = 0xfb
    expect(parseWavPcm(mp3.buffer)).toBeNull()
    // RIFF but a compressed format code (2 = ADPCM) stays with decodeAudioData
    const { buf, view } = wav16()
    view.setUint16(20, 2, true)
    expect(parseWavPcm(buf)).toBeNull()
  })

  it('survives a data chunk whose declared size overruns the file', () => {
    const { buf, view } = wav16({ frames: 4 })
    view.setUint32(40, 9999, true) // lies about its length
    const out = parseWavPcm(buf)!
    expect(out.channels[0]).toHaveLength(4)
  })
})
