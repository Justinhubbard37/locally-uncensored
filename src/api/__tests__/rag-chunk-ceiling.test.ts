/**
 * No chunk may be bigger than the embedder can swallow (ChrisMcSheehy, D#91,
 * 2026-07-27). Document Chat answered an upload with:
 *
 *   Embedding failed (HTTP 500): input (658 tokens) is too large to process.
 *   increase the physical batch size (current batch size: 512)
 *
 * They read that as a setting they were supposed to find. It was ours: the
 * splitter only broke text at sentence ends, so a PDF table, a bullet list,
 * OCR output or a code block, none of which carry a full stop, stayed one
 * "sentence" and went to the embedder whole. One oversized chunk fails the
 * entire document, not just that passage.
 *
 * Run: npx vitest run src/api/__tests__/rag-chunk-ceiling.test.ts
 */
import { describe, it, expect } from 'vitest'
import { chunkText } from '../rag'

/** The ceiling the implementation promises, in characters. */
const MAX = 1200

const longest = (chunks: string[]) => Math.max(0, ...chunks.map((c) => c.length))

describe('chunkText — the ceiling holds for text that has no sentence breaks', () => {
  it('splits a long passage with no full stop at all (the D#91 shape)', () => {
    // A table dump: 400 rows, no punctuation the splitter could use.
    const table = Array.from({ length: 400 }, (_, i) => `row${i} value${i} 12.5 ok`).join(' ')
    const chunks = chunkText(table)
    expect(chunks.length).toBeGreaterThan(1)
    expect(longest(chunks)).toBeLessThanOrEqual(MAX)
  })

  it('splits a bullet list where every line ends without punctuation', () => {
    const list = Array.from({ length: 300 }, (_, i) => `- item number ${i} about something`).join('\n')
    expect(longest(chunkText(list))).toBeLessThanOrEqual(MAX)
  })

  it('splits a code block', () => {
    const code = Array.from({ length: 200 }, (_, i) => `const value${i} = compute(${i}, options)`).join('\n')
    expect(longest(chunkText(code))).toBeLessThanOrEqual(MAX)
  })

  it('splits text with no spaces at all (CJK, a long URL, minified output)', () => {
    const wall = 'x'.repeat(9000)
    const chunks = chunkText(wall)
    expect(chunks.length).toBeGreaterThan(1)
    expect(longest(chunks)).toBeLessThanOrEqual(MAX)
  })

  it('holds the ceiling even where the overlap prefix is added back', () => {
    // Alternating short sentences and a huge unbroken run: the overlap is
    // prepended to the next chunk, which is where a near-limit chunk could
    // tip over.
    const text = Array.from({ length: 30 }, (_, i) =>
      `Sentence ${i} is short. ${'padding word '.repeat(120)}`,
    ).join(' ')
    expect(longest(chunkText(text))).toBeLessThanOrEqual(MAX)
  })

  it('a 20 page document of ordinary prose stays under the ceiling', () => {
    const prose = 'This is a sentence about the subject at hand. '.repeat(1200)
    expect(longest(chunkText(prose))).toBeLessThanOrEqual(MAX)
  })
})

describe('chunkText — ordinary behaviour is unchanged', () => {
  it('still chunks prose at sentence boundaries around the target size', () => {
    const prose = 'Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu. '.repeat(20)
    const chunks = chunkText(prose)
    expect(chunks.length).toBeGreaterThan(1)
    // Target is 500 characters; sentence-aligned chunks land near it.
    expect(longest(chunks)).toBeLessThan(700)
  })

  it('still drops scraps shorter than the minimum', () => {
    expect(chunkText('tiny')).toEqual([])
  })

  it('keeps a short document as a single chunk', () => {
    const one = 'A single paragraph that is comfortably over the twenty character minimum.'
    expect(chunkText(one)).toEqual([one])
  })

  it('loses no words when it has to split hard', () => {
    const words = Array.from({ length: 500 }, (_, i) => `w${i}`)
    const chunks = chunkText(words.join(' '))
    const seen = chunks.join(' ')
    for (const w of [words[0], words[250], words[499]]) {
      expect(seen).toContain(w)
    }
  })
})
