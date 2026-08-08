import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  subscribeApprovals,
  headApproval,
  enqueueApproval,
  dequeueApproval,
  removeApproval,
  drainApprovals,
  resetApprovals,
  type ApprovalEntry,
} from '../approval-queue'
import type { AgentToolCall } from '../../types/agent-mode'

const call = (id: string): AgentToolCall =>
  ({ id, toolName: 'file_edit', args: {}, status: 'pending_approval' }) as AgentToolCall

const entry = (id: string): ApprovalEntry & { answered: boolean[] } => {
  const answered: boolean[] = []
  return { toolCall: call(id), resolve: (ok) => answered.push(ok), answered }
}

describe('G29b: an approval outlives the view that asked for it', () => {
  beforeEach(() => resetApprovals())

  it('a fresh reader finds the approval a torn-down view left behind', () => {
    // The run enqueues while the chat view is being replaced by Settings.
    enqueueApproval('conv-1', entry('tc-1'))
    // The remounted hook asks the module, not its own empty ref.
    expect(headApproval('conv-1')?.id).toBe('tc-1')
  })

  it('keeps FIFO order, so a parallel batch cannot deadlock its first asker', () => {
    // The Phase 5 rule this queue exists for: a single slot would let the
    // second asker overwrite the first, whose promise then never settles.
    const first = entry('tc-1')
    const second = entry('tc-2')
    enqueueApproval('conv-1', first)
    enqueueApproval('conv-1', second)

    expect(headApproval('conv-1')?.id).toBe('tc-1')
    dequeueApproval('conv-1')?.resolve(true)
    expect(first.answered).toEqual([true])
    expect(headApproval('conv-1')?.id).toBe('tc-2')
  })

  it('answers every waiter when the turn ends or Stop is pressed', () => {
    const a = entry('tc-1')
    const b = entry('tc-2')
    enqueueApproval('conv-1', a)
    enqueueApproval('conv-1', b)

    drainApprovals('conv-1')

    expect(a.answered).toEqual([false])
    expect(b.answered).toEqual([false])
    expect(headApproval('conv-1')).toBeNull()
  })

  it('an abort after a click does not answer the same tool twice', () => {
    // waitForApproval only resolves on abort when removeApproval says the
    // entry was still queued. A second resolve would settle nothing but would
    // hide a real double-answer bug from us.
    const e = entry('tc-1')
    enqueueApproval('conv-1', e)
    dequeueApproval('conv-1')?.resolve(true)

    expect(removeApproval('conv-1', e)).toBe(false)
    expect(e.answered).toEqual([true])
  })

  it('notifies subscribers on every change and stops after unsubscribe', () => {
    const seen = vi.fn()
    const off = subscribeApprovals(seen)
    enqueueApproval('conv-1', entry('tc-1'))
    dequeueApproval('conv-1')
    expect(seen).toHaveBeenCalledTimes(2)
    off()
    enqueueApproval('conv-1', entry('tc-2'))
    expect(seen).toHaveBeenCalledTimes(2)
  })

  // ── Negative controls ────────────────────────────────────────────────────

  it('an approval never surfaces in a different conversation', () => {
    // The queue outlives the view, so without the key a run continuing in one
    // chat would ask the user about it while they are reading another.
    enqueueApproval('conv-2', entry('tc-1'))
    expect(headApproval('conv-1')).toBeNull()
    expect(dequeueApproval('conv-1')).toBeUndefined()
    expect(headApproval('conv-2')?.id).toBe('tc-1')
  })

  it('a conversation with nothing pending shows nothing', () => {
    expect(headApproval('conv-1')).toBeNull()
    expect(headApproval(null)).toBeNull()
    expect(headApproval(undefined)).toBeNull()
    expect(dequeueApproval(null)).toBeUndefined()
  })

  it('draining an idle conversation answers nobody', () => {
    const seen = vi.fn()
    subscribeApprovals(seen)
    drainApprovals('conv-1')
    drainApprovals(null)
    expect(headApproval('conv-1')).toBeNull()
  })

  it('leaves no empty queue behind once a conversation is answered', () => {
    // The map outlives every view, so an entry per conversation ever opened
    // would be a slow leak.
    enqueueApproval('conv-1', entry('tc-1'))
    dequeueApproval('conv-1')?.resolve(false)
    expect(headApproval('conv-1')).toBeNull()

    const aborted = entry('tc-2')
    enqueueApproval('conv-2', aborted)
    expect(removeApproval('conv-2', aborted)).toBe(true)
    expect(headApproval('conv-2')).toBeNull()
  })
})
