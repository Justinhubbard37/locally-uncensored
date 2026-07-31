/**
 * Grouping for the tool-call band (David 2026-07-31): consecutive tool_call
 * blocks in a message render as ONE band that morphs from tool to tool while
 * running and collapses to an expandable "N steps" row when done, instead of
 * stacking a chip per call and flooding the chat. Any non-tool block
 * (reflection, answer) ends the current run, so interleaved commentary keeps
 * its position in the transcript.
 *
 * Pure helpers, shared by MessageBubble (Agent) and CodexView (Code tab).
 */

import type { AgentBlock, AgentToolCall } from '../types/agent-mode'

export type AgentBlockGroup =
  | { kind: 'tools'; blocks: AgentBlock[]; calls: AgentToolCall[] }
  | { kind: 'single'; block: AgentBlock }

/** Blocks must already be filtered + timestamp-sorted by the caller. */
export function groupAgentBlocks(blocks: AgentBlock[]): AgentBlockGroup[] {
  const groups: AgentBlockGroup[] = []
  for (const block of blocks) {
    if (block.phase === 'tool_call' && block.toolCall) {
      const last = groups[groups.length - 1]
      if (last && last.kind === 'tools') {
        last.blocks.push(block)
        last.calls.push(block.toolCall)
      } else {
        groups.push({ kind: 'tools', blocks: [block], calls: [block.toolCall] })
      }
    } else {
      groups.push({ kind: 'single', block })
    }
  }
  return groups
}

/** A band is live while any of its calls still needs attention or runtime. */
export function groupIsLive(calls: AgentToolCall[]): boolean {
  return calls.some((c) => c.status === 'running' || c.status === 'pending_approval')
}

/**
 * The call the collapsed band shows: an approval request beats everything
 * (its buttons must be visible), then the earliest still-running call (so
 * parallel batches display in order), else the last call of the group.
 */
export function activeToolCall(calls: AgentToolCall[]): AgentToolCall {
  return (
    calls.find((c) => c.status === 'pending_approval') ??
    calls.find((c) => c.status === 'running') ??
    calls[calls.length - 1]
  )
}

/** Summed duration over the group, formatted like the per-chip label. */
export function groupDurationLabel(calls: AgentToolCall[]): string | null {
  let total = 0
  let seen = false
  for (const c of calls) {
    if (c.duration != null) {
      total += c.duration
      seen = true
    }
  }
  if (!seen) return null
  return total < 1000 ? `${total}ms` : `${(total / 1000).toFixed(1)}s`
}
