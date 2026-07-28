/**
 * The WAV the microphone path hands to whisper.
 *
 * The module's own header explains why LU encodes PCM by hand instead of using
 * MediaRecorder: a malformed blob is the "mic on but no text" bug. Nothing
 * tested the encoder itself.
 */
import { describe, it, expect } from 'vitest'
import { pcmToWav } from '../voice'

async function header(blob: Blob) {
  const buf = await blob.arrayBuffer()
  const v = new DataView(buf)
  const str = (off: number, len: number) =>
    String.fromCharCode(...new Uint8Array(buf, off, len))
  return {
    riff: str(0, 4),
    wave: str(8, 4),
    fmt: str(12, 4),
    audioFormat: v.getUint16(20, true),
    channels: v.getUint16(22, true),
    sampleRate: v.getUint32(24, true),
    byteRate: v.getUint32(28, true),
    blockAlign: v.getUint16(32, true),
    bits: v.getUint16(34, true),
    data: str(36, 4),
    dataLen: v.getUint32(40, true),
    totalLen: buf.byteLength,
  }
}

const tone = (n: number) =>
  Float32Array.from({ length: n }, (_, i) => Math.sin((i / 20) * Math.PI * 2) * 0.5)

describe('the header describes the samples that are actually in the file', () => {
  it('48 kHz input is downsampled and declared as 16 kHz', async () => {
    const h = await header(pcmToWav(tone(48000), 48000))
    expect(h.sampleRate).toBe(16000)
    // One second in, one second out.
    expect(h.dataLen / 2).toBe(16000)
  })

  it('a 16 kHz mic passes through and stays 16 kHz', async () => {
    const h = await header(pcmToWav(tone(16000), 16000))
    expect(h.sampleRate).toBe(16000)
    expect(h.dataLen / 2).toBe(16000)
  })

  it('an 8 kHz mic is declared as 8 kHz, not as 16 kHz', async () => {
    // A Bluetooth headset in HFP mode captures at 8 kHz. The samples are NOT
    // resampled (downsampleTo only ever lowers), so claiming 16 kHz made
    // whisper read the take at double speed.
    const h = await header(pcmToWav(tone(8000), 8000))
    expect(h.sampleRate).toBe(8000)
    expect(h.dataLen / 2).toBe(8000)
    // Rate-derived fields have to follow, or the file is inconsistent.
    expect(h.byteRate).toBe(8000 * 2)
  })

  it('keeps the rest of the header canonical for PCM mono 16-bit', async () => {
    const h = await header(pcmToWav(tone(1000), 44100))
    expect(h.riff).toBe('RIFF')
    expect(h.wave).toBe('WAVE')
    expect(h.fmt).toBe('fmt ')
    expect(h.data).toBe('data')
    expect(h.audioFormat).toBe(1)
    expect(h.channels).toBe(1)
    expect(h.bits).toBe(16)
    expect(h.blockAlign).toBe(2)
    expect(h.byteRate).toBe(h.sampleRate * 2)
    expect(h.totalLen).toBe(44 + h.dataLen)
  })

  it('an empty take produces a valid, empty file rather than junk', async () => {
    const h = await header(pcmToWav(new Float32Array(0), 48000))
    expect(h.riff).toBe('RIFF')
    expect(h.dataLen).toBe(0)
    expect(h.totalLen).toBe(44)
  })

  it('clamps out-of-range samples instead of wrapping them', async () => {
    const blob = pcmToWav(Float32Array.from([2, -2, 0]), 16000)
    const buf = await blob.arrayBuffer()
    const v = new DataView(buf)
    expect(v.getInt16(44, true)).toBe(32767)
    expect(v.getInt16(46, true)).toBe(-32768)
    expect(v.getInt16(48, true)).toBe(0)
  })
})
