import { describe, it, expect } from 'vitest'
import { computeUnifiedDiff, parseUnifiedDiff } from '../diff'

describe('computeUnifiedDiff', () => {
  it('returns empty string when texts are identical', () => {
    const a = 'one\ntwo\nthree'
    expect(computeUnifiedDiff('f.ts', a, a)).toBe('')
  })

  it('emits a +++/--- header for changed files', () => {
    const out = computeUnifiedDiff('src/a.ts', 'one\n', 'two\n')
    expect(out.split('\n').slice(0, 2)).toEqual([
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
    ])
  })

  it('marks added + removed lines with leading sigils', () => {
    const out = computeUnifiedDiff(
      'f',
      'alpha\nbeta\ngamma',
      'alpha\nBETA\ngamma',
    )
    expect(out).toMatch(/-beta/)
    expect(out).toMatch(/\+BETA/)
    expect(out).toMatch(/ alpha/)
    expect(out).toMatch(/ gamma/)
  })

  it('produces a parseable hunk header with correct line counts', () => {
    const out = computeUnifiedDiff(
      'f',
      ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n'),
      ['l1', 'l2', 'l3-changed', 'l4', 'l5'].join('\n'),
    )
    const hunk = out.split('\n').find((l) => l.startsWith('@@'))!
    expect(hunk).toMatch(/^@@ -1,\d+ \+1,\d+ @@$/)
  })

  it('handles pure inserts at the head', () => {
    const out = computeUnifiedDiff('f', 'b\nc\n', 'a\nb\nc\n')
    expect(out).toMatch(/\+a/)
    // No content-line removals — the only `-` prefixes belong to the
    // `--- a/` header.
    const contentLines = out.split('\n').filter((l) => !l.startsWith('---'))
    expect(contentLines.some((l) => l.startsWith('-'))).toBe(false)
  })

  it('handles pure deletes at the tail', () => {
    const out = computeUnifiedDiff('f', 'a\nb\nc\n', 'a\nb\n')
    expect(out).toMatch(/-c/)
  })
})

describe('parseUnifiedDiff round-trip', () => {
  it('classifies headers, hunks, context, add, remove', () => {
    const diff = computeUnifiedDiff(
      'src/x.ts',
      'one\ntwo\nthree\nfour\n',
      'one\nTWO\nthree\nfour\nfive\n',
    )
    const parsed = parseUnifiedDiff(diff)
    expect(parsed.path).toBe('src/x.ts')
    expect(parsed.removed).toBe(1)
    expect(parsed.added).toBe(2)
    expect(parsed.lines.some((l) => l.kind === 'hunk')).toBe(true)
    expect(parsed.lines.some((l) => l.kind === 'context')).toBe(true)
  })

  it('keeps line numbers monotonic in the parsed output', () => {
    const diff = computeUnifiedDiff(
      'f',
      ['a', 'b', 'c', 'd', 'e', 'f'].join('\n'),
      ['a', 'B', 'c', 'd', 'e', 'f'].join('\n'),
    )
    const parsed = parseUnifiedDiff(diff)
    const adds = parsed.lines.filter((l) => l.kind === 'add')
    const removes = parsed.lines.filter((l) => l.kind === 'remove')
    expect(adds[0].newLine).toBeDefined()
    expect(removes[0].oldLine).toBeDefined()
    // No NaN / undefined leaks.
    for (const line of parsed.lines) {
      if (line.oldLine !== undefined) expect(Number.isFinite(line.oldLine)).toBe(true)
      if (line.newLine !== undefined) expect(Number.isFinite(line.newLine)).toBe(true)
    }
  })

  it('survives empty old text (treats whole new file as add)', () => {
    const diff = computeUnifiedDiff('new.txt', '', 'hello\nworld\n')
    const parsed = parseUnifiedDiff(diff)
    expect(parsed.added).toBeGreaterThan(0)
    expect(parsed.removed).toBe(0)
  })
})

// Measured 2026-07-28. Two defects in one function, both on the surface the
// user approves a write from.
describe('hunks are split, and large files do not build a giant LCS table', () => {
  const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`)

  it('splits two distant edits into two hunks instead of one giant one', () => {
    const a = numbered(200)
    const b = [...a]
    b[1] = 'line 2 CHANGED'
    b[198] = 'line 199 CHANGED'
    const diff = computeUnifiedDiff('big.ts', a.join('\n'), b.join('\n'))
    const lines = diff.split('\n')

    // Byte-for-byte what `git diff -U3` produces for the same input.
    expect(lines.filter((l) => l.startsWith('@@'))).toEqual([
      '@@ -1,5 +1,5 @@',
      '@@ -196,5 +196,5 @@',
    ])
    // The whole diff has to fit in the panel (maxLines=40) or the second edit
    // is invisible in what the user approves.
    expect(lines.length).toBeLessThan(20)
    expect(lines.slice(0, 40).join('\n')).toContain('line 199 CHANGED')
  })

  it('keeps a short gap inline as context rather than splitting', () => {
    const a = numbered(20)
    const b = [...a]
    b[4] = 'line 5 CHANGED'
    b[9] = 'line 10 CHANGED' // 4 lines apart — under 2*context
    const diff = computeUnifiedDiff('small.ts', a.join('\n'), b.join('\n'))
    expect(diff.split('\n').filter((l) => l.startsWith('@@'))).toHaveLength(1)
  })

  it('diffs a 20k-line file in milliseconds (the LCS table was O(n*m) memory)', () => {
    const a = numbered(20000).join('\n')
    const b = a.replace('line 1\n', 'line 1 CHANGED\n')
    const started = performance.now()
    const diff = computeUnifiedDiff('huge.ts', a, b)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(diff.split('\n').filter((l) => l.startsWith('@@'))).toHaveLength(1)
  })

  it('falls back to a whole-block replacement past the cell budget', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n')
    const parsed = parseUnifiedDiff(computeUnifiedDiff('x.ts', a, b))
    expect(parsed.removed).toBe(3000)
    expect(parsed.added).toBe(3000)
  })
})
