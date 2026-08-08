// Pending tool approvals, per conversation, at MODULE scope (G29b).
//
// Same lesson as agentLoopTimer in useAgentChat (audit A3): the chat view
// unmounts on a view switch, so anything the run needs after that point cannot
// live in a hook ref. The approval queue did, so a run that asked for approval
// after the switch pushed into the queue of the DEAD instance and told a
// component that no longer exists to show it. The remounted hook started with
// an empty queue, the user saw nothing to approve, and the run waited forever.
// G29 gave that user a Stop button back; this gives them the actual choice.
//
// Keyed by conversation because the queue outlives the view: a run continuing
// in one chat must never surface its approval in another chat the user has
// since opened.
//
// The FIFO itself is the older fix that must survive (Phase 5): parallel tool
// execution means several tools can ask in the same batch, and a single slot
// would be overwritten by the second asker, deadlocking the first.

import type { AgentToolCall } from '../types/agent-mode'

export interface ApprovalEntry {
  toolCall: AgentToolCall
  resolve: (approved: boolean) => void
}

const queues = new Map<string, ApprovalEntry[]>()
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

/** Subscribe to every queue change; returns the unsubscribe function. */
export function subscribeApprovals(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** The approval a conversation is currently waiting on, if any. */
export function headApproval(convId: string | null | undefined): AgentToolCall | null {
  if (!convId) return null
  return queues.get(convId)?.[0]?.toolCall ?? null
}

export function enqueueApproval(convId: string, entry: ApprovalEntry): void {
  const q = queues.get(convId)
  if (q) q.push(entry)
  else queues.set(convId, [entry])
  notify()
}

/** Take the head off and hand it back, so the caller can answer it. */
export function dequeueApproval(convId: string | null | undefined): ApprovalEntry | undefined {
  if (!convId) return undefined
  const q = queues.get(convId)
  if (!q?.length) return undefined
  const entry = q.shift()
  if (!q.length) queues.delete(convId)
  notify()
  return entry
}

/**
 * Drop one specific entry, used when its run aborts. Returns true when the
 * entry was still queued, false when a click already answered it.
 */
export function removeApproval(convId: string, entry: ApprovalEntry): boolean {
  const q = queues.get(convId)
  if (!q) return false
  const idx = q.indexOf(entry)
  if (idx < 0) return false
  q.splice(idx, 1)
  if (!q.length) queues.delete(convId)
  notify()
  return true
}

/** Answer every waiting tool with "no" and empty the queue (turn end, Stop). */
export function drainApprovals(convId: string | null | undefined): void {
  if (!convId) return
  const q = queues.get(convId)
  queues.delete(convId)
  if (q) for (const entry of q) entry.resolve(false)
  notify()
}

/** Test seam only. */
export function resetApprovals(): void {
  queues.clear()
  listeners.clear()
}
