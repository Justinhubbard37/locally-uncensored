import { describe, it, expect } from 'vitest'
import { sliceFileReadResult } from '../file-read-window'

const file = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')

describe('sliceFileReadResult (audit C1)', () => {
  it('returns the whole file untouched when no window is asked for', () => {
    expect(sliceFileReadResult(file, {})).toBe(file)
    expect(sliceFileReadResult(file, { offset: 0, limit: 0 })).toBe(file)
  })

  it('returns a window with header and next-page hint', () => {
    const out = sliceFileReadResult(file, { offset: 3, limit: 4 })
    expect(out).toContain('[lines 3-6 of 10]')
    expect(out).toContain('line 3')
    expect(out).toContain('line 6')
    expect(out).not.toContain('line 7\n')
    expect(out).toContain('offset: 7')
  })

  it('limit alone reads from the top', () => {
    const out = sliceFileReadResult(file, { limit: 2 })
    expect(out).toContain('[lines 1-2 of 10]')
    expect(out).toContain('offset: 3')
  })

  it('offset alone reads to the end, with no next-page hint', () => {
    const out = sliceFileReadResult(file, { offset: 9 })
    expect(out).toContain('[lines 9-10 of 10]')
    expect(out).not.toContain('more line')
  })

  it('an offset past the end yields an empty window, not a crash', () => {
    const out = sliceFileReadResult(file, { offset: 99, limit: 5 })
    expect(out).toContain('of 10]')
    expect(out).not.toContain('line 1')
  })

  it('never adds line-number prefixes to the content itself', () => {
    const out = sliceFileReadResult(file, { offset: 2, limit: 1 })
    const body = out.split('\n')[1]
    expect(body).toBe('line 2')
  })
})
