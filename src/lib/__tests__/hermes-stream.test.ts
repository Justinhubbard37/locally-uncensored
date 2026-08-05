import { describe, it, expect } from 'vitest'
import { createHermesDisplayFilter } from '../hermes-stream'

function run(deltas: string[]): { shown: string; f: ReturnType<typeof createHermesDisplayFilter> } {
  const f = createHermesDisplayFilter()
  let shown = ''
  for (const d of deltas) shown += f.feed(d)
  return { shown, f }
}

describe('hermes display filter', () => {
  it('passes plain prose through unchanged', () => {
    const { shown, f } = run(['Hello ', 'world', '!'])
    expect(shown + f.flush()).toBe('Hello world!')
  })

  it('swallows a complete tool call and keeps surrounding text', () => {
    const { shown, f } = run([
      'Before. ',
      '<tool_call>{"name":"file_write","arguments":{"path":"a"}}</tool_call>',
      ' After.',
    ])
    expect(shown + f.flush()).toBe('Before.  After.')
  })

  it('swallows a call whose tags are split across many deltas', () => {
    const { shown, f } = run([
      'Text <tool_',
      'call>{"name":"x"',
      ',"arguments":{}}</tool_',
      'call> more',
    ])
    expect(shown + f.flush()).toBe('Text  more')
  })

  it('does not flash any part of the call body mid-stream', () => {
    const f = createHermesDisplayFilter()
    let shown = ''
    shown += f.feed('ok <tool_call>{"name":"secret_tool"')
    expect(shown).toBe('ok ')
    expect(f.inToolCall()).toBe(true)
    shown += f.feed(',"arguments":{}}</tool_call> done')
    expect(shown + f.flush()).toBe('ok  done')
  })

  it('releases a tag-lookalike that never completes', () => {
    const { shown, f } = run(['a < b and <tool', '_x is not a tag'])
    expect(shown + f.flush()).toBe('a < b and <tool_x is not a tag')
  })

  it('flushes a trailing opening-tag prefix as prose at stream end', () => {
    const { shown, f } = run(['ends with <tool_ca'])
    expect(shown).toBe('ends with ')
    expect(f.flush()).toBe('<tool_ca')
  })

  it('keeps an unclosed call swallowed at stream end', () => {
    const { shown, f } = run(['x <tool_call>{"name":"y"'])
    expect(shown).toBe('x ')
    expect(f.flush()).toBe('')
  })

  it('handles several calls in one turn', () => {
    const { shown, f } = run([
      'one <tool_call>{"a":1}</tool_call> two <tool_call>{"b":2}</tool_call> three',
    ])
    expect(shown + f.flush()).toBe('one  two  three')
  })

  it('handles a close tag split exactly at the angle bracket', () => {
    const { shown, f } = run([
      '<tool_call>{"n":"x"}<',
      '/tool_call>after',
    ])
    expect(shown + f.flush()).toBe('after')
  })
})
