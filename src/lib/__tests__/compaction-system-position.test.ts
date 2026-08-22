/**
 * The trim notice was a role:'system' message pushed BETWEEN the pinned task
 * and the kept window, so every compaction planted a system message mid
 * conversation. Strict Jinja chat templates refuse exactly that; llama-server
 * and LM Studio render them with the template's own raise_exception, and the
 * run dies with "System message must be at the beginning".
 *
 * Reported on Discord #bug-reports (2026-08-21): platorius, "the problem is
 * only in LU. It has very often problems. When i use Unsloth Desktop, i can
 * copy paste the same prompts and no problem" (same prompts elsewhere are
 * fine because compaction only fires once the history is long), and
 * helpslowlydying's diagnosis of the crash, "the system instructions or
 * tools are being injected in the wrong order, causing the Jinja template
 * engine to crash with System message must be at the beginning".
 *
 * The notice now rides inside a user message (appended to the pinned task,
 * or prefixed to the first kept user turn, or as its own user turn when the
 * window starts with an assistant turn), so after compaction there is at
 * most ONE system message and it sits at index 0.
 *
 * Run: npx vitest run src/lib/__tests__/compaction-system-position.test.ts
 */
import { describe, it, expect } from 'vitest'
import { compactMessages } from '../context-compaction'

type Msg = Parameters<typeof compactMessages>[0][number]

const big = (n: number) => 'x'.repeat(n)

const round = (tool: string, resultSize = 1200): Msg[] => [
  { role: 'assistant', content: '', tool_calls: [{ function: { name: tool } }] } as unknown as Msg,
  { role: 'tool', content: big(resultSize) } as Msg,
]

const longRun = (): Msg[] => [
  { role: 'system', content: 'You are a helpful agent.' } as Msg,
  { role: 'user', content: 'Work through the plan.' } as Msg,
  ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].flatMap((t) => round(`tool_${t}`)),
]

const systemIndices = (msgs: Msg[]): number[] =>
  msgs.map((m, i) => (m.role === 'system' ? i : -1)).filter((i) => i >= 0)

const noticeCount = (msgs: Msg[]): number =>
  msgs.reduce((n, m) => {
    const c = typeof m.content === 'string' ? m.content : ''
    return n + (c.match(/\[\d+ earlier message/g)?.length ?? 0)
  }, 0)

describe('after compaction, system only ever sits at index 0', () => {
  it('a compacted run has exactly one system message and it is first', () => {
    const out = compactMessages(longRun(), 1500)
    expect(noticeCount(out)).toBe(1)
    expect(systemIndices(out)).toEqual([0])
  })

  it('a run without any system prompt gains none from compaction', () => {
    const out = compactMessages(longRun().slice(1), 1500)
    expect(noticeCount(out)).toBe(1)
    expect(systemIndices(out)).toEqual([])
  })

  it('the notice rides the pinned task instead of trailing it as system', () => {
    const out = compactMessages(longRun(), 1500)
    const task = out.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Work through the plan.'),
    )
    expect(task).toBeTruthy()
    expect(task!.content).toMatch(/\[\d+ earlier messages? (?:was|were) trimmed to fit the context window\./)
  })

  it('without any user turn in history the notice becomes its own user turn, never system', () => {
    const noUser: Msg[] = [
      { role: 'system', content: 'sys' } as Msg,
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].flatMap((t) => round(`tool_${t}`)),
    ]
    const out = compactMessages(noUser, 1500)
    expect(systemIndices(out)).toEqual([0])
    const carrier = out.find(
      (m) => typeof m.content === 'string' && /\[\d+ earlier message/.test(m.content),
    )
    expect(carrier).toBeTruthy()
    expect(carrier!.role).toBe('user')
  })

  it('REGRESSION: compacting an already-compacted history does not stack notices', () => {
    const once = compactMessages(longRun(), 1500)
    const grown: Msg[] = [
      ...once,
      ...['i', 'j', 'k', 'l', 'm', 'n'].flatMap((t) => round(`tool_${t}`)),
    ]
    const twice = compactMessages(grown, 1500)
    expect(noticeCount(twice)).toBe(1)
    expect(systemIndices(twice)).toEqual([0])
  })

  it('NEGATIVE CONTROL: within budget nothing is added or moved', () => {
    const short: Msg[] = [
      { role: 'system', content: 'sys' } as Msg,
      { role: 'user', content: 'hi' } as Msg,
      { role: 'assistant', content: 'hello' } as Msg,
    ]
    expect(compactMessages(short, 100000)).toEqual(short)
  })
})
