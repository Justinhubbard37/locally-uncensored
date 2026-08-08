import { describe, it, expect, beforeEach } from 'vitest'
import { useTodoStore, normalizeTodos, summarizeTodos, writeTodos } from '../todoStore'

// The plan the model writes through `todo_write` (audit C4). Everything here is
// about surviving what a small local model actually sends: a 3B model asked for
// {content, status} will sooner or later send a bare string, a missing status,
// a status it invented, or forty items.

beforeEach(() => {
  useTodoStore.setState({ byConversation: {}, updatedAt: {} })
})

describe('normalizeTodos survives what a model sends', () => {
  it('keeps well-formed items as they are', () => {
    expect(
      normalizeTodos([
        { content: 'read the file', status: 'completed' },
        { content: 'fix the bug', status: 'in_progress' },
        { content: 'run the tests', status: 'pending' },
      ]),
    ).toEqual([
      { content: 'read the file', status: 'completed' },
      { content: 'fix the bug', status: 'in_progress' },
      { content: 'run the tests', status: 'pending' },
    ])
  })

  it('treats an unknown status as not started', () => {
    // The dangerous direction is the other one: a typo must never be read as
    // done, or the user sees work ticked off that never happened.
    expect(normalizeTodos([{ content: 'x', status: 'donezo' }])[0].status).toBe('pending')
    expect(normalizeTodos([{ content: 'x', status: 'DONE' }])[0].status).toBe('pending')
    expect(normalizeTodos([{ content: 'x' }])[0].status).toBe('pending')
  })

  it('drops entries with no usable content instead of rendering blanks', () => {
    expect(
      normalizeTodos([
        { content: '  ', status: 'pending' },
        'just a string',
        null,
        42,
        { status: 'completed' },
        { content: 'real one', status: 'pending' },
      ]),
    ).toEqual([{ content: 'real one', status: 'pending' }])
  })

  it('returns an empty plan for anything that is not a list', () => {
    for (const junk of [undefined, null, 'todos', 42, { todos: [] }]) {
      expect(normalizeTodos(junk)).toEqual([])
    }
  })

  it('caps runaway lists and runaway items', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ content: `step ${i}`, status: 'pending' }))
    expect(normalizeTodos(many)).toHaveLength(40)

    const long = normalizeTodos([{ content: 'x'.repeat(1000), status: 'pending' }])
    expect(long[0].content.length).toBe(200)
  })

  it('trims whitespace so the strip does not render ragged', () => {
    expect(normalizeTodos([{ content: '  padded  ', status: 'pending' }])[0].content).toBe('padded')
  })
})

describe('the plan is per conversation', () => {
  it('does not leak between two chats', () => {
    writeTodos('chat-a', [{ content: 'a-step', status: 'pending' }])
    writeTodos('chat-b', [{ content: 'b-step', status: 'completed' }])

    expect(useTodoStore.getState().getTodos('chat-a')).toEqual([{ content: 'a-step', status: 'pending' }])
    expect(useTodoStore.getState().getTodos('chat-b')).toEqual([{ content: 'b-step', status: 'completed' }])
  })

  it('replaces the whole list rather than merging', () => {
    writeTodos('c', [
      { content: 'one', status: 'completed' },
      { content: 'two', status: 'in_progress' },
    ])
    writeTodos('c', [{ content: 'only this', status: 'pending' }])

    // Merging would leave 'one' and 'two' behind and show a plan the model never
    // wrote. Whole-list replacement is the contract the tool description states.
    expect(useTodoStore.getState().getTodos('c')).toEqual([{ content: 'only this', status: 'pending' }])
  })

  it('reports an empty plan for an unknown or missing conversation', () => {
    expect(useTodoStore.getState().getTodos('never-seen')).toEqual([])
    expect(useTodoStore.getState().getTodos(null)).toEqual([])
    expect(useTodoStore.getState().getTodos(undefined)).toEqual([])
  })

  it('clearing one chat leaves the other alone', () => {
    writeTodos('keep', [{ content: 'k', status: 'pending' }])
    writeTodos('drop', [{ content: 'd', status: 'pending' }])
    useTodoStore.getState().clearTodos('drop')

    expect(useTodoStore.getState().getTodos('keep')).toHaveLength(1)
    expect(useTodoStore.getState().getTodos('drop')).toEqual([])
  })
})

describe('the summary handed back to the model', () => {
  it('states progress and the current step', () => {
    const out = summarizeTodos([
      { content: 'read', status: 'completed' },
      { content: 'edit', status: 'in_progress' },
      { content: 'test', status: 'pending' },
    ])
    expect(out).toContain('1/3 done')
    expect(out).toContain('now: edit')
    // The model has to be able to read its own plan back without us replaying
    // the whole list into the context on every turn.
    expect(out).toContain('[x] read')
    expect(out).toContain('[>] edit')
    expect(out).toContain('[ ] test')
  })

  it('says so plainly when the plan is emptied', () => {
    expect(summarizeTodos([])).toBe('Plan cleared.')
  })

  it('omits the current step when nothing is in progress', () => {
    const out = summarizeTodos([{ content: 'a', status: 'pending' }])
    expect(out).toContain('0/1 done')
    expect(out).not.toContain('now:')
  })
})
