// Regression guard for #110: the gallery reported seed 0 for every random
// run, so two different images both claimed to come from the same seed and
// neither could be reproduced. The dice are thrown once per run now, and the
// number that comes out of here is the number the sampler gets AND the number
// the gallery stores.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveRunSeed } from '../run-seed'

afterEach(() => { vi.restoreAllMocks() })

describe('resolveRunSeed', () => {
  it('turns the -1 placeholder into a concrete seed, never 0', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(resolveRunSeed(-1)).toBe(1073741823)
  })

  it('passes a user-chosen seed through untouched, so the builders cannot re-roll it', () => {
    expect(resolveRunSeed(42)).toBe(42)
    expect(resolveRunSeed(2147483646)).toBe(2147483646)
    expect(resolveRunSeed(0)).toBe(0)
  })

  it('floors a fractional seed instead of handing ComfyUI a float', () => {
    expect(resolveRunSeed(12.9)).toBe(12)
  })

  it('stays inside the 32 bit signed range the KSampler accepts', () => {
    for (const r of [0, 0.25, 0.999999]) {
      vi.spyOn(Math, 'random').mockReturnValue(r)
      const s = resolveRunSeed(-1)
      expect(Number.isInteger(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(2147483647)
      vi.restoreAllMocks()
    }
  })

  it('rolls a different number on consecutive random runs', () => {
    const seeds = new Set(Array.from({ length: 50 }, () => resolveRunSeed(-1)))
    expect(seeds.size).toBeGreaterThan(45)
    expect(seeds.has(0)).toBe(false)
  })

  it('treats any negative or broken value as a roll, not as a literal seed', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(resolveRunSeed(-7)).toBe(1073741823)
    expect(resolveRunSeed(Number.NaN)).toBe(1073741823)
  })
})
