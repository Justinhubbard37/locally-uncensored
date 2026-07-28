/**
 * chunkForTts — what read-aloud actually sends to the synthesizer.
 *
 * Each chunk becomes its OWN audio clip, played back to back, so a cut in the
 * wrong place is audible: the listener hears half a word, a pause, then the
 * other half. src/api/voice.ts had no tests at all.
 *
 * Measured against the version before this round: 200 Japanese sentences came
 * out as ONE part (the splitter needed a space after 。, which CJK does not
 * write) and the fallback cut landed inside a word.
 */
import { describe, it, expect } from 'vitest'
import { chunkForTts } from '../voice'

const MAX = 1400

describe('sentence splitting works without spaces after the terminator', () => {
  it('splits Japanese on 。 even though nothing follows it', () => {
    const jp = 'これはテストです。'.repeat(200)
    const chunks = chunkForTts(jp, MAX)

    expect(chunks.length).toBeGreaterThan(1)
    // Every chunk must end on a sentence boundary, never mid-word.
    for (const c of chunks) {
      expect(c.endsWith('。')).toBe(true)
    }
    expect(chunks.join('')).toBe(jp)
  })

  it('still splits Latin prose on the usual terminators', () => {
    const en = 'This is a sentence. '.repeat(200)
    const chunks = chunkForTts(en, MAX)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.trim().endsWith('.')).toBe(true)
  })

  it('leaves short text in one piece and drops empty input', () => {
    expect(chunkForTts('Kurz.', MAX)).toEqual(['Kurz.'])
    expect(chunkForTts('   ', MAX)).toEqual([])
  })
})

describe('the fallback cut for a run with no sentence end', () => {
  it('does not cut a word in half when the text has spaces', () => {
    const long = 'das ist ein sehr langer satz ohne satzzeichen '.repeat(60)
    const chunks = chunkForTts(long, MAX)

    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      // A chunk that starts or ends mid-word is the audible defect.
      expect(c.startsWith(' ')).toBe(false)
      expect(c.endsWith(' ')).toBe(false)
    }
    // Rejoining with the spaces the split consumed gives the original back.
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long.trim().replace(/\s+/g, ' '))
  })

  it('never splits a surrogate pair', () => {
    // Emoji sitting exactly on the boundary: a naive slice yields two lone
    // surrogates, which are invalid in the JSON body the cloud TTS call sends.
    const text = 'a'.repeat(MAX - 1) + '😀' + 'b'.repeat(50)
    const chunks = chunkForTts(text, MAX)

    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) {
        const code = c.charCodeAt(i)
        const isHigh = code >= 0xd800 && code <= 0xdbff
        const isLow = code >= 0xdc00 && code <= 0xdfff
        if (isHigh) {
          const next = c.charCodeAt(i + 1)
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
          i++
        } else {
          expect(isLow).toBe(false)
        }
      }
    }
    expect(chunks.join('')).toContain('😀')
  })

  it('keeps every chunk within the limit', () => {
    const long = 'これはテストです。'.repeat(400) + 'x'.repeat(3000)
    for (const c of chunkForTts(long, MAX)) {
      expect(c.length).toBeLessThanOrEqual(MAX)
    }
  })
})
