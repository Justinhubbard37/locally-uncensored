/**
 * Context-fill semantics for the TokenCounter (David, 2026-07-12): a looping
 * cloud reasoner burned its whole 16,384-token completion budget as hidden
 * thinking; the old high-water over usage.totalTokens pinned the counter at
 * "16.5k" for the rest of the conversation while the next real prompt cost
 * 65 tokens. Reasoning is never resent, so it is never context.
 *
 * Run: npx vitest run src/lib/__tests__/token-usage.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { computeContextFill, type FillMessage } from '../token-usage'
import { estimateTokens } from '../context-compaction'

const user = (content: string): FillMessage => ({ role: 'user', content })
const assistant = (content: string, extra: Partial<FillMessage> = {}): FillMessage =>
  ({ role: 'assistant', content, ...extra })

describe('computeContextFill', () => {
  it('estimates from visible content only when no usage exists', () => {
    const msgs = [user('hello there'), assistant('hi!')]
    const expected = estimateTokens('hello there') + 4 + estimateTokens('hi!') + 4
    expect(computeContextFill(msgs)).toEqual({ used: expected, real: false, source: 'estimate' })
  })

  it('never counts thinking — with or without a usage anchor', () => {
    const noAnchor = [user('q'), assistant('', { thinking: 'x'.repeat(40000) })]
    expect(computeContextFill(noAnchor).used).toBeLessThan(50)

    const anchored = [
      user('q'),
      assistant('', {
        thinking: 'x'.repeat(40921),
        usage: { promptTokens: 85, completionTokens: 16384, totalTokens: 16469 },
      }),
    ]
    // The crashout turn: 85 real prompt tokens + an empty visible reply.
    // The old high-water showed 16,469 here.
    const fill = computeContextFill(anchored)
    expect(fill.used).toBeLessThan(150)
    expect(fill.used).toBeGreaterThanOrEqual(85)
    expect(fill.real).toBe(true)
  })

  it('anchors on the newest usage and adds visible messages after it', () => {
    const msgs = [
      user('first'),
      assistant('a1', { usage: { promptTokens: 500, completionTokens: 20, totalTokens: 520 } }),
      user('second'),
      assistant('a2', { usage: { promptTokens: 900, completionTokens: 30, totalTokens: 930 } }),
      user('third — not answered yet'),
    ]
    const tail =
      estimateTokens('a2') + 4 +
      estimateTokens('third — not answered yet') + 4
    expect(computeContextFill(msgs)).toEqual({ used: 900 + tail, real: true , source: 'usage' })
  })

  it('a provisional (estimated) anchor is used but not reported as real', () => {
    const msgs = [
      user('q'),
      assistant('a', { usage: { promptTokens: 300, completionTokens: 10, totalTokens: 310, estimated: true } }),
    ]
    const fill = computeContextFill(msgs)
    expect(fill.used).toBe(300 + estimateTokens('a') + 4)
    expect(fill.real).toBe(false)
  })

  it('counts toolCallSummary as visible context', () => {
    const withTool = computeContextFill([assistant('a', { toolCallSummary: 'used web_search("x") → 3 results' })])
    const without = computeContextFill([assistant('a')])
    expect(withTool.used).toBeGreaterThan(without.used)
  })

  it('an honest dip after compaction beats a sticky wrong maximum', () => {
    // Turn 1 fed an image (expensive prompt), turn 2 compacted it away.
    const msgs = [
      user('look at this image'),
      assistant('I see a cat', { usage: { promptTokens: 3500, completionTokens: 40, totalTokens: 3540 } }),
      user('thanks'),
      assistant('yw', { usage: { promptTokens: 1200, completionTokens: 5, totalTokens: 1205 } }),
    ]
    // Anchored on the NEWEST usage (1200), not the conversation maximum.
    expect(computeContextFill(msgs).used).toBeLessThan(1400)
  })
})

describe('a brand new chat starts at nothing', () => {
  const COUNTER = readFileSync(
    resolve(__dirname, '..', '..', 'components', 'chat', 'TokenCounter.tsx'),
    'utf8',
  )

  it('an empty conversation has no fill', () => {
    expect(computeContextFill([])).toEqual({ used: 0, real: false, source: 'estimate' })
  })

  it('the counter draws nothing at all while the chat is empty', () => {
    // No render harness in this repo, so the empty-state exit is guarded at
    // the source, the way send-window.test.ts guards the denominator.
    expect(COUNTER).toMatch(/if \(!activeConversationId \|\| messages\.length === 0\) return null/)
  })
})

describe('the tool chain a run writes back is not new context', () => {
  // A coding run reports the size of the request it built while the store
  // still holds [user, assistant placeholder]. The hidden tool chain is
  // written back at run END and spliced in BEFORE the assistant message
  // (useCodex insertMessagesBefore). Those results were inside the built
  // request already, so adding them again doubles the meter on the very
  // first run of a fresh chat: 15k of real prompt read as 30k.
  const toolResult = (content: string): FillMessage =>
    ({ role: 'tool', content, hidden: true })

  const built = { tokens: 15000, atMessageCount: 2 }

  it('counts the persisted chain once, not twice', () => {
    const afterRun: FillMessage[] = [
      user('refactor the parser'),
      toolResult('x'.repeat(40000)),
      toolResult('y'.repeat(40000)),
      assistant('done'),
    ]
    const fill = computeContextFill(afterRun, built)
    expect(fill.source).toBe('built')
    expect(fill.used).toBe(15000 + estimateTokens('done') + 4)
  })

  it('still adds what the user typed after the build', () => {
    const afterRun: FillMessage[] = [
      user('refactor the parser'),
      toolResult('x'.repeat(40000)),
      assistant('done'),
      user('now run the suite'),
    ]
    const fill = computeContextFill(afterRun, built)
    expect(fill.used).toBe(
      15000 + estimateTokens('done') + 4 + estimateTokens('now run the suite') + 4,
    )
  })
})
