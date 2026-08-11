/**
 * Applying staged changes to disk — shared by the StagedChangesPanel buttons
 * and Codex auto-apply (settings.codexAutoApply), so both paths write through
 * the exact same trusted call.
 *
 * Writes go via fs_write DIRECTLY, not the `file_write` model tool. Two
 * reasons: (1) by apply time the loop's finally may have cleared the active
 * chat/workspace, so file_write's chatCtx() is empty and the write would jail
 * to agent-workspace/default — rejecting the absolute project path. (2)
 * file_write deliberately does NOT let its caller pick the jail root (2.5.7
 * security review: a prompt-injected model could set workingDirectory to
 * escape the sandbox). Apply is a trusted, user-gated action, so it is safe
 * to pass the workspace root captured at stage time as the jail root.
 */

import { backendCall } from '../api/backend'
import { useStagedChangesStore, type StagedChange } from '../stores/stagedChangesStore'
import { useChatStore } from '../stores/chatStore'
import { mergeThreeWay } from './three-way-merge'

/**
 * Decide what to write when the file moved on since it was staged.
 *
 * A staged change carries the file as it looked when the model wrote it. The
 * user reviews the diff and clicks Apply minutes later, and in between the file
 * may well have changed: they fixed a line themselves, another tool ran in the
 * same folder, or an earlier entry of this very queue landed. Writing
 * `newContent` blindly reverts all of that, with no undo.
 *
 * Refusing was the first answer to that, and it turned into its own bug: every
 * file in Morgan's finished run refused, so a plan the app reported as done
 * wrote nothing (2026-08-11). Refusing is only correct when the two edits
 * really collide. So:
 *
 *   1. baseline intact       -> write what was approved
 *   2. already that content  -> nothing to do, treat as applied
 *   3. foreign edit elsewhere-> merge both and write the result
 *   4. same lines both sides -> refuse, this one needs a human
 *
 * Only steps 2 to 4 need the baseline. `oldContent` is also empty when the
 * stage-time read failed (useCodex treats a failed read as "new file"), and
 * gating on that would break applies that are perfectly fine.
 */
async function reconcile(
  chatId: string,
  change: StagedChange,
): Promise<{ content: string; merged: number }> {
  if (!change.oldContent) return { content: change.newContent, merged: 0 }
  let current: string
  try {
    const res = await backendCall<{ content?: string }>('fs_read', {
      path: change.resolvedPath || change.path,
      chatId,
      workingDirectory: change.workingDirectory,
    })
    current = res?.content ?? ''
  } catch {
    // gone or unreadable, the write recreates it, which is what the user asked for
    return { content: change.newContent, merged: 0 }
  }
  if (current === change.oldContent || current === change.newContent) {
    return { content: change.newContent, merged: 0 }
  }
  const merged = mergeThreeWay(change.oldContent, current, change.newContent)
  if (merged.ok) {
    return { content: merged.content, merged: merged.mergedRegions }
  }
  throw new Error(
    `${change.path} changed on disk in the same ${merged.conflicts === 1 ? 'place' : 'places'} this edit touches, so applying it would drop those changes. Everything else was left alone. Reject this one and let the model read the file again.`,
  )
}

export async function applyStagedChange(chatId: string, change: StagedChange): Promise<void> {
  const { content, merged } = await reconcile(chatId, change)
  const res = await backendCall<{ status?: string; path?: string }>('fs_write', {
    path: change.resolvedPath || change.path,
    content,
    chatId,
    workingDirectory: change.workingDirectory,
  })
  // 'saved' and 'unchanged' are both success ('unchanged' = the file already
  // matched byte-for-byte). Anything else is a real failure worth retrying.
  if (res?.status && res.status !== 'saved' && res.status !== 'unchanged') {
    throw new Error(`fs_write returned status "${res.status}"`)
  }
  useStagedChangesStore.getState().remove(chatId, change.id)
  // Mirror the apply in the chat log so the user sees a confirmation in the
  // main pane, not just the side-pane entry disappearing. A merge is named as
  // one: the file that landed is not byte for byte the diff that was reviewed.
  useChatStore.getState().addMessage(chatId, {
    id: crypto.randomUUID(),
    role: 'system',
    content: merged > 0
      ? `Applied staged change: ${change.path} (merged with ${merged} change${merged === 1 ? '' : 's'} made on disk since it was staged)`
      : `Applied staged change: ${change.path}`,
    timestamp: Date.now(),
    hidden: true,
  })
}

/** Apply every pending change for a chat, sequentially (fs_write serializes
 *  per path anyway). Failures stay in the queue for manual retry and are
 *  reported by path instead of throwing, so one bad write never blocks the
 *  rest. */
export async function applyAllStagedChanges(
  chatId: string,
): Promise<{ applied: string[]; failed: string[] }> {
  const applied: string[] = []
  const failed: string[] = []
  for (const change of [...useStagedChangesStore.getState().list(chatId)]) {
    try {
      await applyStagedChange(chatId, change)
      applied.push(change.path)
    } catch {
      failed.push(change.path)
    }
  }
  return { applied, failed }
}
