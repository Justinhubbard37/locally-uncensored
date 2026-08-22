/**
 * Feedback 2026-08-21 (yaserrieh@gmail.com, hosted-pro, route /): "Error:
 * [network] HTTP 400 too many messages". Plain chat sends the whole
 * conversation every turn, so past the server's message-count limit the
 * chat is stuck forever. The recovery halves the sent history and retries,
 * no guessed server number, and never touches the stored conversation.
 *
 * Run: npx vitest run src/lib/__tests__/too-many-messages.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { isTooManyMessagesError, halveHistory, TOO_MANY_MESSAGES_MAX_HALVINGS } from '../too-many-messages'

type Msg = { role: string; content: string }
const m = (role: string, i: number): Msg => ({ role, content: `${role} ${i}` })

const history = (turns: number): Msg[] => [
  { role: 'system', content: 'sys' },
  ...Array.from({ length: turns }, (_, i) => [m('user', i), m('assistant', i)]).flat(),
]

describe('isTooManyMessagesError', () => {
  it('matches the exact server refusal, case-insensitively', () => {
    expect(isTooManyMessagesError(new Error('[network] HTTP 400 too many messages'))).toBe(true)
    expect(isTooManyMessagesError(new Error('Too Many Messages'))).toBe(true)
  })

  it('NEGATIVE CONTROL: other 400s and other errors never trigger the halving', () => {
    expect(isTooManyMessagesError(new Error('HTTP 400 invalid payload'))).toBe(false)
    expect(isTooManyMessagesError(new Error('does not support thinking'))).toBe(false)
    expect(isTooManyMessagesError(new Error('too many requests'))).toBe(false)
    expect(isTooManyMessagesError(undefined)).toBe(false)
  })
})

describe('halveHistory', () => {
  it('keeps the system prompt and the newest half, starting on a user turn', () => {
    const out = halveHistory(history(20))!
    expect(out[0].role).toBe('system')
    expect(out.length).toBeLessThan(41)
    expect(out[1].role).toBe('user')
    expect(out[out.length - 1].content).toBe('assistant 19')
  })

  it('always retains the latest user turn, however small the half', () => {
    let msgs: Msg[] | null = history(50)
    for (let i = 0; i < TOO_MANY_MESSAGES_MAX_HALVINGS; i++) {
      const next: Msg[] | null = halveHistory(msgs!)
      if (!next) break
      expect(next.some((x) => x.content === 'user 49')).toBe(true)
      msgs = next
    }
  })

  it('works without a system prompt', () => {
    const out = halveHistory(history(10).slice(1))!
    expect(out[0].role).toBe('user')
    expect(out.length).toBeLessThan(20)
  })

  it('returns null once nothing sensible is left, so the caller surfaces the real error', () => {
    expect(halveHistory([{ role: 'system', content: 's' }, m('user', 0), m('assistant', 0)])).toBeNull()
    expect(halveHistory([m('user', 0)])).toBeNull()
    expect(halveHistory([])).toBeNull()
  })

  it('NEGATIVE CONTROL: the input array is never mutated', () => {
    const msgs = history(12)
    const before = JSON.stringify(msgs)
    halveHistory(msgs)
    expect(JSON.stringify(msgs)).toBe(before)
  })

  it('a handful of halvings shrinks any long history below any plausible limit', () => {
    let msgs: Msg[] | null = history(500)
    for (let i = 0; i < TOO_MANY_MESSAGES_MAX_HALVINGS && msgs; i++) msgs = halveHistory(msgs)
    expect(msgs).not.toBeNull()
    expect(msgs!.length).toBeLessThanOrEqual(33)
  })
})

describe('wiring (source guards)', () => {
  const chatSrc = readFileSync(join(__dirname, '../../hooks/useChat.ts'), 'utf8').replace(/\r\n/g, '\n')

  it('the plain-chat stream fallback halves and retries on the count refusal', () => {
    expect(chatSrc).toContain('if (isTooManyMessagesError(err))')
    expect(chatSrc).toContain('halveHistory(messages)')
    expect(chatSrc).toContain('provider.chatStream(modelId, trimmed, chatOpts)')
  })

  it('the retry is bounded and re-throws anything that is not the count refusal', () => {
    expect(chatSrc).toContain('attempt >= TOO_MANY_MESSAGES_MAX_HALVINGS) throw retryErr')
  })
})
