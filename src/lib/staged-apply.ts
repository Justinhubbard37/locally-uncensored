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

/**
 * Refuse to apply on top of someone else's edit.
 *
 * A staged change carries the file as it looked when the model wrote it. The
 * user reviews the diff and clicks Apply minutes later — and in between they may
 * well have touched the file themselves ("I'll just fix that one line"). Writing
 * `newContent` then silently reverts their work, with no undo. We already hold
 * the stage-time baseline, so the check is a single read.
 *
 * Only enforced when we HAVE a baseline: `oldContent` is also empty when the
 * stage-time read failed for any reason (useCodex treats a failed read as "new
 * file"), and blocking on that would break applies that are perfectly fine.
 */
async function assertNoDrift(chatId: string, change: StagedChange): Promise<void> {
  if (!change.oldContent) return
  let current: string
  try {
    const res = await backendCall<{ content?: string }>('fs_read', {
      path: change.resolvedPath || change.path,
      chatId,
      workingDirectory: change.workingDirectory,
    })
    current = res?.content ?? ''
  } catch {
    return // gone or unreadable — the write recreates it, which is what the user asked for
  }
  if (current !== change.oldContent) {
    throw new Error(
      `${change.path} changed on disk after this edit was staged — applying would overwrite those changes. Reject it and let the model read the file again.`,
    )
  }
}

export async function applyStagedChange(chatId: string, change: StagedChange): Promise<void> {
  await assertNoDrift(chatId, change)
  const res = await backendCall<{ status?: string; path?: string }>('fs_write', {
    path: change.resolvedPath || change.path,
    content: change.newContent,
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
  // main pane, not just the side-pane entry disappearing.
  useChatStore.getState().addMessage(chatId, {
    id: crypto.randomUUID(),
    role: 'system',
    content: `Applied staged change: ${change.path}`,
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
