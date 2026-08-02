import { describe, it, expect } from 'vitest'
import {
  groupAgentBlocks,
  groupIsLive,
  activeToolCall,
  groupDurationLabel,
} from '../tool-call-groups'
import type { AgentBlock, AgentToolCall } from '../../types/agent-mode'

let ts = 0
function call(name: string, status: AgentToolCall['status'], duration?: number): AgentToolCall {
  return { id: `c-${++ts}`, toolName: name, args: {}, status, duration, timestamp: ts }
}
function toolBlock(tc: AgentToolCall): AgentBlock {
  return { id: `b-${tc.id}`, phase: 'tool_call', content: '', toolCall: tc, toolCalls: [tc], timestamp: ++ts }
}
function answerBlock(content: string): AgentBlock {
  return { id: `a-${++ts}`, phase: 'answer', content, timestamp: ts }
}

describe('groupAgentBlocks', () => {
  it('collects consecutive tool calls into one group', () => {
    const a = toolBlock(call('file_read', 'completed'))
    const b = toolBlock(call('file_write', 'completed'))
    const groups = groupAgentBlocks([a, b])
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('tools')
    expect((groups[0] as any).calls.map((c: AgentToolCall) => c.toolName)).toEqual(['file_read', 'file_write'])
  })

  it('splits groups at interleaved answers, keeping order', () => {
    const t1 = toolBlock(call('file_read', 'completed'))
    const ans = answerBlock('found it')
    const t2 = toolBlock(call('file_write', 'completed'))
    const t3 = toolBlock(call('shell_execute', 'completed'))
    const groups = groupAgentBlocks([t1, ans, t2, t3])
    expect(groups.map(g => g.kind)).toEqual(['tools', 'single', 'tools'])
    expect((groups[2] as any).calls).toHaveLength(2)
  })

  it('keeps a lone tool call as a group of one', () => {
    const groups = groupAgentBlocks([toolBlock(call('web_search', 'running'))])
    expect(groups).toHaveLength(1)
    expect((groups[0] as any).calls).toHaveLength(1)
  })

  it('passes a tool_call block without a call payload through as single', () => {
    const broken: AgentBlock = { id: 'x', phase: 'tool_call', content: '', timestamp: 1 }
    const groups = groupAgentBlocks([broken])
    expect(groups[0].kind).toBe('single')
  })
})

describe('band state helpers', () => {
  it('is live while any call runs or awaits approval, done otherwise', () => {
    expect(groupIsLive([call('a', 'completed'), call('b', 'running')])).toBe(true)
    expect(groupIsLive([call('a', 'completed'), call('b', 'pending_approval')])).toBe(true)
    expect(groupIsLive([call('a', 'completed'), call('b', 'failed')])).toBe(false)
  })

  it('active call prefers approval, then earliest running, then the last call', () => {
    const done = call('a', 'completed')
    const run1 = call('b', 'running')
    const run2 = call('c', 'running')
    const pending = call('d', 'pending_approval')
    expect(activeToolCall([done, run1, run2, pending]).toolName).toBe('d')
    expect(activeToolCall([done, run1, run2]).toolName).toBe('b')
    expect(activeToolCall([done, call('e', 'failed')]).toolName).toBe('e')
  })

  it('sums durations into the chip duration format', () => {
    expect(groupDurationLabel([call('a', 'completed', 300), call('b', 'completed', 400)])).toBe('700ms')
    expect(groupDurationLabel([call('a', 'completed', 800), call('b', 'completed', 700)])).toBe('1.5s')
    expect(groupDurationLabel([call('a', 'running')])).toBeNull()
  })
})
