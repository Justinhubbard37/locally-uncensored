import { describe, it, expect } from 'vitest'
import { BENCHMARK_PROMPTS } from '../benchmark-prompts'

/**
 * B6 (David 2026-08-05): the benchmark checks the ANSWER, not the reasoning.
 * The failure this guards against is a model that reasons its way to the right
 * number and then runs out of token budget before printing it. A speed-only
 * benchmark calls that a fast run; the check calls it wrong.
 */
const check = (id: string) => BENCHMARK_PROMPTS.find((p) => p.id === id)!.check

describe('benchmark prompt checks', () => {
  describe('speed: list 1 to 50', () => {
    const speed = check('speed')
    it('passes a full list', () => {
      expect(speed(Array.from({ length: 50 }, (_, i) => i + 1).join('\n'))).toBe(true)
    })
    it('fails a list cut off before the end', () => {
      expect(speed(Array.from({ length: 30 }, (_, i) => i + 1).join('\n'))).toBe(false)
    })
    it('fails empty output', () => {
      expect(speed('')).toBe(false)
    })
  })

  describe('reasoning: 17 sheep, all but 9 stay', () => {
    const reasoning = check('reasoning')
    it('passes when the answer ends on 9', () => {
      expect(reasoning('All but 9 stay, so the farmer has 9 sheep left.')).toBe(true)
    })
    it('passes the answer spelled out', () => {
      expect(reasoning('The farmer has nine sheep left.')).toBe(true)
    })
    it('fails the classic 17 minus 9 equals 8 slip', () => {
      expect(reasoning('17 minus 9 is 8, so 8 sheep are left.')).toBe(false)
    })
    it('fails an answer that never states the number', () => {
      // The exact case David hit: the reasoning reached 9 but the budget ran
      // out first, so the visible answer carries no number at all.
      expect(reasoning('Let me work through this carefully. A farmer keeps')).toBe(false)
    })
  })

  describe('code: a fibonacci function', () => {
    const code = check('code')
    it('passes a real definition', () => {
      expect(code('def fibonacci(n):\n    """nth fib"""\n    return n')).toBe(true)
    })
    it('fails prose that never defines it', () => {
      expect(code('Fibonacci numbers are a famous sequence in mathematics.')).toBe(false)
    })
  })

  it('every prompt carries a check', () => {
    for (const p of BENCHMARK_PROMPTS) expect(typeof p.check).toBe('function')
  })
})
