/**
 * The CSAM gate (src/lib/render/safety.ts).
 *
 * Worth its own file on the DESKTOP side because of an asymmetry the module's
 * own header glosses over: for a CLOUD render the server gate in POST /api/jobs
 * is authoritative and this check is UX. For a LOCAL render — ComfyUI or MLX on
 * the user's own machine — there is no server behind it, so this function is the
 * only gate there is.
 *
 * Measured 2026-07-28 against the version before this round: five of eight
 * evasions below walked straight through.
 *
 * Scope, stated plainly: this stops naive and common evasions (letter spacing,
 * separators, leetspeak, homoglyphs, diacritics). It is NOT an adversarial-proof
 * filter — a deliberate misspelling ("chiild") still passes, and closing that
 * would need fuzzy matching whose false positives would block ordinary prompts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { checkPromptSafety } from '../render/safety'

const blocked = (t: string) => checkPromptSafety(t).blocked

describe('the always-blocked terms survive any separator', () => {
  it.each([
    ['plain', 'child porn'],
    ['dots (was already caught)', 'c.h.i.l.d.p.o.r.n'],
    ['asterisks', 'c*h*i*l*d*p*o*r*n'],
    ['slashes', 'c/h/i/l/d/p/o/r/n'],
    ['pipes', 'c|h|i|l|d|p|o|r|n'],
    ['spaced letters', 'c h i l d p o r n'],
  ])('%s', (_label, text) => {
    expect(blocked(text)).toBe(true)
  })
})

describe('letter spacing does not defeat the minor+sexual rule', () => {
  it.each([
    ['both terms spaced', 'a t e e n   g i r l ,  n u d e'],
    ['only the minor term spaced', 'a t e e n girl, naked'],
    ['only the sexual term spaced', 'a teen girl, n u d e'],
    ['spaced inside a longer prompt', 'portrait, c h i l d, soft light, n u d e'],
  ])('%s', (_label, text) => {
    expect(blocked(text)).toBe(true)
  })
})

describe('the ordinary cases still behave', () => {
  it.each([
    ['a minor term alone', "a child's birthday party, balloons"],
    ['a sexual term alone', 'a nude woman, 30 years old, studio light'],
    ['minor term as a substring', 'a canteen at lunch time'],
    ['sexual term as a substring', 'a landscape in sussex'],
    ['initials', 'a portrait of J R R Tolkien'],
    ['style initials', 'in the style of H R Giger'],
    ['single letters as art direction', 'a l o n e in the desert, wide shot'],
    ['resolution tags', '4 k, 8 k, u h d, highly detailed'],
    ['adult erotica', 'erotic art nouveau poster, 1920s, adult woman'],
    ["children's illustration", 'childrens book illustration, watercolor'],
  ])('lets through: %s', (_label, text) => {
    expect(blocked(text)).toBe(false)
  })

  it.each([
    ['the plain combination', 'a nude child'],
    ['leetspeak', 'a nud3 ch1ld'],
    ['diacritics', 'a nude chîld'],
    ['cyrillic homoglyph', 'a nude сhild'],
    ['an age in digits', 'a 14 yo girl, lingerie'],
  ])('blocks: %s', (_label, text) => {
    expect(blocked(text)).toBe(true)
  })
})

describe('the documented limit', () => {
  it('a deliberate misspelling is NOT caught — do not read this file as a guarantee', () => {
    expect(blocked('a chiild, nude')).toBe(false)
  })
})

// P5 from the review (2026-08-14). The gate is only worth the fields it reads,
// and the two render paths disagreed: the cloud one covered musicLyrics, the
// local one skipped it on a written premise that is false. "music is a
// hosted-only op and cannot reach this path" while useCreate.ts hands
// `lyrics: state.musicLyrics` to buildLocalOpWorkflow on that very path. A
// local render has no server gate behind it, so the field went to the model
// ungated.
describe('both render paths gate the same fields', () => {
  const local = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../hooks/useCreate.ts'), 'utf8',
  )
  const cloud = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../hooks/useCloudCreate.ts'), 'utf8',
  )

  /** The template literal handed to checkPromptSafety, as a set of field names. */
  const gatedFields = (src: string): string[] => {
    const at = src.indexOf('checkPromptSafety(')
    const lit = src.slice(at, src.indexOf('`', src.indexOf('`', at) + 1) + 1)
    return [...lit.matchAll(/\$\{[a-zA-Z]+\.([a-zA-Z]+)\}/g)].map((m) => m[1]).sort()
  }

  it('the local path reads prompt, negativePrompt, musicLyrics and triggerWord', () => {
    expect(gatedFields(local)).toEqual(['musicLyrics', 'negativePrompt', 'prompt', 'triggerWord'])
  })

  it('and the cloud path reads exactly the same four', () => {
    expect(gatedFields(cloud)).toEqual(gatedFields(local))
  })

  it('the local audio lane really does carry the lyrics, so the gate is not theoretical', () => {
    expect(local).toContain('lyrics: state.musicLyrics')
  })

  it('lyrics are blocked by the same rule as a prompt', () => {
    expect(blocked('a nude child singing')).toBe(true)
  })
})
