/**
 * NumberField must honour the bounds it declares (2026-07-28)
 *
 * min/max/step on <input type="number"> are advisory — React stores whatever
 * was typed or pasted. A Width declared 64..4096 step 64 therefore reached the
 * generator as 9999 or 3, and the job failed in the backend (in cloud mode
 * after the request was already out).
 *
 * Run: npx vitest run src/components/create/ui/__tests__/NumberField-bounds.test.ts
 */
import { describe, it, expect } from 'vitest'
import { commitNumber } from '../NumberField'

describe('commitNumber', () => {
  it('clamps a value above the declared maximum', () => {
    expect(commitNumber(9999, 64, 4096, 64)).toBe(4096)
  })

  it('clamps a value below the declared minimum', () => {
    expect(commitNumber(3, 64, 4096, 64)).toBe(64)
    expect(commitNumber(-512, 64, 4096, 64)).toBe(64)
  })

  it('snaps to the step grid the field advertises', () => {
    expect(commitNumber(100, 64, 4096, 64)).toBe(128)
    expect(commitNumber(1024, 64, 4096, 64)).toBe(1024)
  })

  it('leaves an unbounded field alone (seed accepts -1)', () => {
    expect(commitNumber(-1, undefined, undefined, 1)).toBe(-1)
    expect(commitNumber(123456, undefined, undefined, 1)).toBe(123456)
  })
})
