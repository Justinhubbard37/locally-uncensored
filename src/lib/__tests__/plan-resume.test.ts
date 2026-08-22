/**
 * Resuming a plan must be a mechanism, not hope.
 *
 * David, 2026-08-22 on the running build: an agent run with a plan was
 * interrupted by a side question, the model answered in prose and left the
 * plan lying. "continue" then asked the model to rediscover its own plan in a
 * history it may no longer hold. G27b hands it over instead: one line at the
 * end of the next request, built from the todoStore.
 *
 * Run: npx vitest run src/lib/__tests__/plan-resume.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { planResumeAnchor } from '../plan-resume'
import { buildRequestMessages, trimWorkingHistory, type DecayMessage } from '../context-decay'
import { useTodoStore } from '../../stores/todoStore'
import type { TodoItem } from '../../stores/todoStore'

const here = dirname(fileURLToPath(import.meta.url))
const src = (...p: string[]) => readFileSync(resolve(here, '../..', ...p), 'utf8')

const t = (content: string, status: TodoItem['status']): TodoItem => ({ content, status })

/** David's shape: a long plan, a few steps in, interrupted mid-flight. */
const INTERRUPTED: TodoItem[] = [
  t('Read the existing router', 'completed'),
  t('Sketch the new endpoint', 'completed'),
  t('Write src/api/orders.ts', 'in_progress'),
  t('Wire the route', 'pending'),
  t('Add a test', 'pending'),
]

describe('the anchor fires exactly when a plan is open', () => {
  it('an interrupted plan produces the line, with the numbers and the next step', () => {
    const resume = planResumeAnchor(INTERRUPTED)
    expect(resume).not.toBeNull()
    expect(resume!.gap).toEqual({ done: 2, total: 5, next: 'Write src/api/orders.ts' })
    expect(resume!.text).toContain('2 of 5')
    expect(resume!.text).toContain('Write src/api/orders.ts')
  })

  it('the user keeps the right of way, and the plan can be rewritten', () => {
    const { text } = planResumeAnchor(INTERRUPTED)!
    expect(text).toMatch(/unless/i)
    expect(text).toMatch(/comes first/i)
    expect(text).toContain('todo_write')
  })

  it('it is one short line, not a second system prompt', () => {
    expect(planResumeAnchor(INTERRUPTED)!.text.length).toBeLessThan(400)
  })

  it('NEGATIVE CONTROL: no plan at all, no anchor', () => {
    expect(planResumeAnchor([])).toBeNull()
  })

  it('NEGATIVE CONTROL: a finished plan is finished, no anchor', () => {
    expect(planResumeAnchor([t('a', 'completed'), t('b', 'completed')])).toBeNull()
  })

  it('NEGATIVE CONTROL: the last open step closing removes the anchor', () => {
    const nearlyDone = INTERRUPTED.map((i) => t(i.content, 'completed'))
    expect(planResumeAnchor(nearlyDone)).toBeNull()
  })
})

describe('the state comes from the store, not from the history', () => {
  beforeEach(() => {
    useTodoStore.setState({ byConversation: {}, updatedAt: {} })
  })

  it('reads the live plan of THIS conversation', () => {
    useTodoStore.getState().setTodos('conv-a', INTERRUPTED)
    useTodoStore.getState().setTodos('conv-b', [t('other work', 'pending')])
    const a = planResumeAnchor(useTodoStore.getState().getTodos('conv-a'))
    const b = planResumeAnchor(useTodoStore.getState().getTodos('conv-b'))
    expect(a!.text).toContain('2 of 5')
    expect(b!.text).toContain('0 of 1')
  })

  it('a conversation without a plan gets nothing', () => {
    expect(planResumeAnchor(useTodoStore.getState().getTodos('never-planned'))).toBeNull()
  })

  it('the store wins over a stale todo_write still sitting in the history', () => {
    // The history says 1 of 5 because that todo_write is three steps old; the
    // store says 4 of 5 because the model kept working. The anchor must carry
    // the store's number, which is exactly what the PlanBar shows the user.
    useTodoStore.getState().setTodos('conv-a', [
      ...INTERRUPTED.slice(0, 4).map((i) => t(i.content, 'completed')),
      t('Add a test', 'in_progress'),
    ])
    const stale = 'Plan updated (1/5 done, now: Sketch the new endpoint).'
    const resume = planResumeAnchor(useTodoStore.getState().getTodos('conv-a'))
    expect(resume!.text).toContain('4 of 5')
    expect(resume!.text).not.toContain(stale)
  })
})

describe('A5: the anchor rides in the volatile tail and survives the decay', () => {
  /** What the hooks build: system head, history, the user's new message, anchor. */
  const request = (): DecayMessage[] => {
    const { text } = planResumeAnchor(INTERRUPTED)!
    const history: DecayMessage[] = [
      { role: 'system', content: 'STABLE HEAD' },
      { role: 'user', content: 'build the orders endpoint' },
    ]
    for (let i = 0; i < 12; i++) {
      history.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, function: { name: 'file_read', arguments: { path: `f${i}.ts` } } }] })
      history.push({ role: 'tool', content: `body ${i} ${'x'.repeat(4000)}`, tool_call_id: `c${i}` })
    }
    history.push({ role: 'user', content: 'continue' })
    history.push({ role: 'user', content: text })
    return history
  }

  it('the anchor is the LAST message, so the stable head keeps its bytes', () => {
    const msgs = request()
    expect(msgs[msgs.length - 1].content).toContain('2 of 5')
    expect(msgs[0].content).toBe('STABLE HEAD')
  })

  it('a tight send window drops old results but never the anchor', () => {
    const msgs = request()
    const trimmed = trimWorkingHistory(msgs, 2000).messages
    const built = buildRequestMessages(trimmed, { budgetTokens: 2000 })
    const last = built.messages[built.messages.length - 1]
    expect(String(last.content)).toContain('2 of 5')
    expect(built.messages[0].content).toBe('STABLE HEAD')
    expect(built.messages.length).toBeLessThan(msgs.length)
  })
})

/**
 * Line comments are stripped before any of the wiring checks below. Without
 * that, commenting the anchor out leaves every assertion green (measured while
 * running the negative control for this very file), which would make these
 * tests a search for a sentence rather than for working code.
 */
const codeOnly = (s: string) =>
  s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

describe('both surfaces are wired, in the request copy only', () => {
  const codex = codeOnly(src('hooks', 'useCodex.ts'))
  const agent = codeOnly(src('hooks', 'useAgentChat.ts'))

  it('useCodex appends it to the request array before the persist marker', () => {
    expect(codex).toContain('planResumeAnchor(useTodoStore.getState().getTodos(convId))')
    const pushAt = codex.indexOf("messages.push({ role: 'user', content: resume.text })")
    const builtAt = codex.indexOf('let messages: ChatMessage[] = [')
    const startLenAt = codex.indexOf('const messagesStartLen = messages.length')
    expect(pushAt).toBeGreaterThan(builtAt)
    // Before the marker the hidden-history persist slices from: the anchor is
    // a request line, it must never be written back into the conversation.
    expect(pushAt).toBeLessThan(startLenAt)
  })

  it('useAgentChat appends it to agentMessages, after the media intent is read', () => {
    expect(agent).toContain('planResumeAnchor(useTodoStore.getState().getTodos(convId))')
    const pushAt = agent.indexOf("agentMessages.push({ role: 'user', content: resume.text })")
    const builtAt = agent.indexOf('let agentMessages: ChatMessage[] = [')
    const promptTextAt = agent.indexOf('const userPromptText =')
    const loopAt = agent.indexOf('while (runningRef.current && !abort.signal.aborted)')
    expect(pushAt).toBeGreaterThan(builtAt)
    expect(pushAt).toBeGreaterThan(promptTextAt)
    expect(pushAt).toBeLessThan(loopAt)
  })

  it('neither surface writes the anchor into the visible chat', () => {
    for (const hook of [codex, agent]) {
      expect(hook).not.toMatch(/addMessage\([^)]*resume\.text/)
      expect(hook).not.toMatch(/updateMessageContent\([^)]*resume\.text/)
    }
  })

  it('it is pushed once per turn, outside the loop', () => {
    expect(codex.match(/resume\.text/g)).toHaveLength(1)
    expect(agent.match(/resume\.text/g)).toHaveLength(1)
  })

  it('NEGATIVE CONTROL: it does not touch the in-run steer budgets', () => {
    const block = (s: string) => s.slice(s.indexOf('const resume = planResumeAnchor'), s.indexOf('const resume = planResumeAnchor') + 400)
    for (const hook of [codex, agent]) {
      expect(block(hook)).not.toContain('planReconcilesRemaining')
      expect(block(hook)).not.toContain('planStaleness')
    }
  })
})
