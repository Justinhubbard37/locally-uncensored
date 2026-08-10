// The retry guard reads the status off whichever field the transport used.
//
// Morgan, 2026-08-10: an out-of-credits agent run "was still cycling". It was
// not. The guard "never retry a deterministic 4xx" read `statusCode`, which
// only the Ollama path sets, so on the cloud path (ProviderError, `.status`)
// the refusal fell through to the transient branch and was retried twice with
// 1.5 s and 3 s of backoff before anything reached the screen.
import { describe, it, expect } from 'vitest'
import { httpStatusOf, isTerminalModelError } from '../http-status'
import { ProviderError } from '../../api/providers/types'

describe('httpStatusOf', () => {
  it('reads the cloud transport, which carries `status` (ProviderError)', () => {
    expect(httpStatusOf(new ProviderError('out of credits', 'openai', 'credits_exhausted', 429))).toBe(429)
  })

  it('reads the Ollama transport, which carries `statusCode`', () => {
    expect(httpStatusOf(Object.assign(new Error('HTTP 400: nope'), { statusCode: 400 }))).toBe(400)
  })

  it('is 0 for everything that carries no status at all', () => {
    for (const e of [null, undefined, 'boom', new Error('Failed to fetch'), {}, { status: '429' }, { status: Number.NaN }]) {
      expect(httpStatusOf(e)).toBe(0)
    }
  })
})

describe('isTerminalModelError', () => {
  it('an empty wallet is terminal, whatever the status says', () => {
    expect(isTerminalModelError(new ProviderError('out of credits', 'openai', 'credits_exhausted', 429))).toBe(true)
  })

  it('REGRESSION: the same refusal was NOT terminal while the guard read statusCode', () => {
    // The exact object the cloud path threw. Reading `statusCode` alone yields
    // undefined, so the old rule classified it as transient and retried it.
    const err = new ProviderError('out of credits', 'openai', 'credits_exhausted', 429)
    expect((err as unknown as { statusCode?: number }).statusCode).toBeUndefined()
    expect(isTerminalModelError(err)).toBe(true)
  })

  it('a deterministic 4xx is terminal on both transports', () => {
    expect(isTerminalModelError(new ProviderError('context overflow', 'openai', undefined, 400))).toBe(true)
    expect(isTerminalModelError(Object.assign(new Error('x'), { statusCode: 404 }))).toBe(true)
    expect(isTerminalModelError(new ProviderError('bad key', 'openai', 'auth', 401))).toBe(true)
  })

  it('NEGATIVE CONTROL: a throttle is NOT terminal, so a burst still retries', () => {
    // LU Cloud answers 429 for three things. Two of them (the per-user burst
    // guard and an upstream provider throttle) pass retry-after and clear on
    // their own; only the empty wallet is final. Treating every 429 as
    // terminal would turn a two-second wait into a failed run.
    expect(isTerminalModelError(new ProviderError('too many requests', 'openai', 'rate_limit', 429))).toBe(false)
    expect(isTerminalModelError(Object.assign(new Error('rate limited'), { statusCode: 429 }))).toBe(false)
  })

  it('server trouble and network trouble stay retryable', () => {
    expect(isTerminalModelError(new ProviderError('bad gateway', 'openai', undefined, 502))).toBe(false)
    expect(isTerminalModelError(new ProviderError('overloaded', 'anthropic', undefined, 529))).toBe(false)
    expect(isTerminalModelError(new Error('Failed to fetch'))).toBe(false)
  })
})
