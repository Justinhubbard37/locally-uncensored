/**
 * Compaction pinned the task and dropped the progress, so a long run started
 * the task over from the top.
 *
 * Measured on the installed 2.6.2 Windows build, Coding surface, Ollama with
 * the hermes schema, 2026-08-06. A 30 step plan, one step per tool. The run
 * walked steps 1 to 18 in order and then, in the very next call, did this:
 *
 *   … git_status, git_diff, git_commit, git_log,
 *     todo_write, get_current_time, system_info, process_list, file_list, …
 *
 * That second half is steps 1 to 5 again. David, watching it: "es wiederholt
 * sich die ganze Zeit ... das fängt so ab, ruft neu an. Und er sagt immer
 * dasselbe."
 *
 * The cause is the shape of the compacted prompt. `PINNED_TASK` (audit C5)
 * keeps the instruction alive forever, the suffix window keeps the newest few
 * messages, and everything between them is replaced by a notice that says a
 * trim happened but never says WHAT already ran. The model is left holding a
 * 30 step plan and no evidence of having started it, so starting at step 1 is
 * the only reasonable thing it can do.
 *
 * Run: npx vitest run src/lib/__tests__/compaction-keeps-progress.test.ts
 */
import { describe, it, expect } from 'vitest'
import { compactMessages } from '../context-compaction'

type Msg = Parameters<typeof compactMessages>[0][number]

const big = (n: number) => 'x'.repeat(n)

/** One hermes round: the assistant asks, the user carries the result back. */
const hermesRound = (tool: string, resultSize = 1200): Msg[] => [
  {
    role: 'assistant',
    content: `<tool_call>\n{"name": "${tool}", "arguments": {"path": "src/math.js", "name": "inner-key-that-must-not-win"}}\n</tool_call>`,
  } as Msg,
  { role: 'user', content: `<tool_response>\n${big(resultSize)}\n</tool_response>` } as Msg,
]

/** The same round on the native transport. */
const nativeRound = (tool: string, resultSize = 1200): Msg[] => [
  { role: 'assistant', content: '', tool_calls: [{ function: { name: tool } }] } as unknown as Msg,
  { role: 'tool', content: big(resultSize) } as Msg,
]

const PLAN_TOOLS = [
  'todo_write', 'get_current_time', 'system_info', 'process_list', 'file_list',
  'file_read', 'file_search', 'file_write', 'file_edit', 'shell_execute',
  'run_tests', 'code_execute', 'project_init', 'git_status', 'git_diff',
  'git_commit', 'git_log',
]

const buildRun = (round: (t: string, n?: number) => Msg[]): Msg[] => [
  { role: 'system', content: 'You are a function calling AI model. ' + big(4000) } as Msg,
  { role: 'user', content: 'Work through this plan: 1. todo_write 2. get_current_time 3. …' } as Msg,
  ...PLAN_TOOLS.flatMap((t) => round(t)),
]

const noticeOf = (msgs: Msg[]): string => {
  const n = msgs.find(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('['),
  )
  return n && typeof n.content === 'string' ? n.content : ''
}

describe('the trim notice carries the trail of what already ran', () => {
  it('hermes: it names the dropped calls in order', () => {
    const out = compactMessages(buildRun(hermesRound), 3000)
    const notice = noticeOf(out)
    expect(notice).toContain('Already done in this run, in order')
    expect(notice).toMatch(/todo_write, get_current_time, system_info, process_list, file_list/)
  })

  it('native: same trail from tool_calls', () => {
    const out = compactMessages(buildRun(nativeRound), 3000)
    expect(noticeOf(out)).toMatch(/todo_write, get_current_time, system_info/)
  })

  it('it says outright not to start over, which is the failure it prevents', () => {
    const notice = noticeOf(compactMessages(buildRun(hermesRound), 3000))
    expect(notice).toMatch(/do not start the task again from the beginning/i)
  })

  it('a "name" inside the ARGUMENTS never wins over the tool name', () => {
    const notice = noticeOf(compactMessages(buildRun(hermesRound), 3000))
    expect(notice).not.toContain('inner-key-that-must-not-win')
  })

  it('the anti-re-read wording from the earlier fix survives', () => {
    const notice = noticeOf(compactMessages(buildRun(hermesRound), 3000))
    expect(notice).toMatch(/never repeat a call that already ran/)
  })

  it('a very long trail is bounded and says so instead of silently cutting', () => {
    const many = [
      { role: 'system', content: 'sys ' + big(4000) } as Msg,
      { role: 'user', content: 'the plan' } as Msg,
      ...Array.from({ length: 60 }, (_, i) => hermesRound(`tool_${i}`)).flat(),
    ]
    const out = compactMessages(many, 3000)
    const notice = noticeOf(out)
    expect(notice).toMatch(/\d+ earlier calls omitted/)
    // The trail covers the DROPPED calls and stops there. The newest rounds
    // are not in it because they are still in the window verbatim, which is
    // the whole point: the notice fills the gap, it does not duplicate what
    // the model can already read.
    expect(notice).toContain('tool_54')
    expect(notice).not.toContain('tool_59')
    const kept = JSON.stringify(out.filter((m) => m.role !== 'system'))
    expect(kept).toContain('tool_59')
  })
})

describe('what must not change', () => {
  it('NEGATIVE CONTROL: nothing was dropped, so there is no notice and no trail', () => {
    const short: Msg[] = [
      { role: 'system', content: 'sys' } as Msg,
      { role: 'user', content: 'hi' } as Msg,
      ...hermesRound('file_list', 10),
    ]
    const out = compactMessages(short, 100000)
    expect(out).toEqual(short)
    expect(noticeOf(out)).toBe('')
  })

  it('the task itself is still pinned, that fix is not undone', () => {
    const out = compactMessages(buildRun(hermesRound), 3000)
    const user = out.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Work through this plan'))
    expect(user).toBeTruthy()
  })

  it('the system prompt is still first', () => {
    const out = compactMessages(buildRun(hermesRound), 3000)
    expect(out[0].role).toBe('system')
    expect(out[0].content).toContain('function calling AI model')
  })
})
