/**
 * The plan belongs in the PlanBar, not thirty times in the transcript.
 *
 * David, 2026-08-06, having said it before: "Du solltest auch die
 * Planbenachrichtigung und den Planfortschritt nicht im Transfer haben."
 *
 * Captured on the installed 2.6.2 build during a 30 step Coding run, reading
 * the transcript over CDP: plan items were sitting between the steps, e.g.
 * "Generate video with valid sampler and model", because every `todo_write`
 * dropped a card carrying the whole list. An agent that revises its plan each
 * step writes that list thirty times.
 *
 * Run: npx vitest run src/lib/__tests__/transcript-visibility.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { hiddenFromTranscript } from '../transcript-visibility'

describe('todo_write is owned by the PlanBar', () => {
  it('a completed plan write leaves no card behind', () => {
    expect(hiddenFromTranscript({ toolName: 'todo_write', status: 'completed' })).toBe(true)
  })

  it('and neither does one still running, so no card flashes up and vanishes', () => {
    expect(hiddenFromTranscript({ toolName: 'todo_write', status: 'running' })).toBe(true)
  })

  it('or one served from the in-turn cache', () => {
    expect(hiddenFromTranscript({ toolName: 'todo_write', status: 'cached' })).toBe(true)
  })
})

describe('NEGATIVE CONTROL: it stays visible when the user needs to know', () => {
  // The whole point of hiding it is that the PlanBar says the same thing
  // better. When the write FAILED the PlanBar says nothing at all, so the card
  // is the only evidence the plan was never recorded.
  it('a failed plan write is still shown', () => {
    expect(hiddenFromTranscript({ toolName: 'todo_write', status: 'failed' })).toBe(false)
  })

  it('a rejected one is still shown', () => {
    expect(hiddenFromTranscript({ toolName: 'todo_write', status: 'rejected' })).toBe(false)
  })

  it('one waiting for approval is still shown, or it could never be approved', () => {
    expect(hiddenFromTranscript({ toolName: 'todo_write', status: 'pending_approval' })).toBe(false)
  })
})

describe('NEGATIVE CONTROL: nothing else is touched', () => {
  it('every other tool renders in every state', () => {
    const others = ['file_read', 'shell_execute', 'git_commit', 'web_search', 'image_generate']
    const states = ['completed', 'running', 'cached', 'failed', 'rejected', 'pending_approval']
    for (const toolName of others) {
      for (const status of states) {
        expect(hiddenFromTranscript({ toolName, status })).toBe(false)
      }
    }
  })

  it('an unknown tool name is never hidden by accident', () => {
    expect(hiddenFromTranscript({ toolName: 'some_mcp_server__thing', status: 'completed' })).toBe(false)
  })

  it('a tool whose name merely CONTAINS todo_write is not hidden', () => {
    expect(hiddenFromTranscript({ toolName: 'not_todo_write', status: 'completed' })).toBe(false)
    expect(hiddenFromTranscript({ toolName: 'todo_write_v2', status: 'completed' })).toBe(false)
  })
})

describe('the gate runs before the block mounts', () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../components/chat/ToolCallBlock.tsx'),
    'utf8',
  )

  it('ToolCallBlock asks the rule', () => {
    expect(src).toMatch(/hiddenFromTranscript\(props\.toolCall\)/)
  })

  it('and the check sits outside the implementation, so no hook order changes', () => {
    // An early return inside ToolCallBlockImpl would have to come after its
    // useState/useEffect calls, which is exactly the shape that rots later.
    const gate = src.indexOf('hiddenFromTranscript(props.toolCall)')
    const impl = src.indexOf('function ToolCallBlockImpl')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(impl)
  })
})
