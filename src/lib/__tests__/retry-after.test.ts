/**
 * A throttled run has to outlast the window that throttled it.
 *
 * Review 2026-08-14. isTerminalModelError deliberately leaves 429 retryable,
 * and its docstring justifies that with the retry-after the server sends. The
 * client never read that header: the only occurrence of the string in the
 * whole desktop tree was the claim itself. The retry site waited 1.5 s and
 * then 3 s, while LU Cloud's burst guard is a FIXED window (60 requests per
 * 60 s) whose retry-after can be anything up to a full minute. Both attempts
 * landed inside the same window that had just refused them, the loop threw
 * after 4.5 s, and the user read "Agent error: too many requests" with nothing
 * to do about it. The carve-out that exists to save a throttled run never
 * saved one.
 *
 * Run: npx vitest run src/lib/__tests__/retry-after.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseRetryAfter, retryDelayMs, MAX_RETRY_AFTER_MS } from '../http-status'
import { ProviderError } from '../../api/providers/types'

const headers = (value: string | null) => ({ headers: { get: () => value } })

afterEach(() => vi.useRealTimers())

describe('parseRetryAfter', () => {
  it('reads whole seconds, which is what LU Cloud sends', () => {
    expect(parseRetryAfter(headers('42'))).toBe(42_000)
    expect(parseRetryAfter(headers(' 7 '))).toBe(7_000)
    expect(parseRetryAfter(headers('0'))).toBe(0)
  })

  it('reads the HTTP-date shape too, so another provider is not ignored', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T10:00:00Z'))
    expect(parseRetryAfter(headers('Fri, 14 Aug 2026 10:00:30 GMT'))).toBe(30_000)
    // A date already in the past means "now", not a negative wait.
    expect(parseRetryAfter(headers('Fri, 14 Aug 2026 09:59:00 GMT'))).toBe(0)
  })

  it('treats a missing or broken header as absent, never as zero', () => {
    // Absent must fall back to the caller's own ladder. Returning 0 would turn
    // a malformed header into a tight loop against the limiter.
    for (const v of [null, '', 'soon', '-5']) {
      expect(parseRetryAfter(headers(v))).toBeUndefined()
    }
  })
})

describe('retryDelayMs', () => {
  const throttled = (ms?: number) =>
    new ProviderError('too many requests', 'lu-cloud', 'rate_limit', 429, undefined, ms)

  it('waits what the server asked for, instead of guessing far too short', () => {
    expect(retryDelayMs(throttled(45_000), 1)).toBe(45_000)
    // The old ladder for the same failure, for contrast.
    expect(1500 * 1).toBeLessThan(retryDelayMs(throttled(45_000), 1))
  })

  it('keeps the old ladder when no header came', () => {
    expect(retryDelayMs(throttled(undefined), 1)).toBe(1500)
    expect(retryDelayMs(throttled(undefined), 2)).toBe(3000)
    expect(retryDelayMs(new Error('Failed to fetch'), 2)).toBe(3000)
  })

  it('caps a wild number, a run must not freeze for minutes', () => {
    expect(retryDelayMs(throttled(600_000), 1)).toBe(MAX_RETRY_AFTER_MS)
  })

  it('keeps a beat when the server says zero', () => {
    expect(retryDelayMs(throttled(0), 1)).toBe(250)
  })

  it('ignores a nonsense value on the error', () => {
    expect(retryDelayMs({ retryAfterMs: 'soon' }, 1)).toBe(1500)
    expect(retryDelayMs({ retryAfterMs: Number.NaN }, 2)).toBe(3000)
    expect(retryDelayMs({ retryAfterMs: -1 }, 1)).toBe(1500)
  })
})
