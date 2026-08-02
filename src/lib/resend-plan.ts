import type { ImageAttachment, Message } from '../types/chat'

/**
 * What has to leave the thread before a turn is sent again — Regenerate and
 * Edit-and-resend share this, because they are the same operation with a
 * different starting point.
 *
 * Both used to leave the original user message in place and then let
 * sendMessage add a SECOND copy of it: the question showed up twice, once more
 * with every further click, and the model was asked it twice. Attachments were
 * dropped on the way, so regenerating a vision turn re-asked the question
 * without the image. And in an agent thread the message before the answer is a
 * tool result, not the question, so Regenerate did nothing at all.
 */
export interface ResendPlan {
  /** First message to drop — deleteMessagesAfter removes it and everything after it. */
  deleteFromId: string
  /** Exactly what sendMessage receives as the user's input. */
  content: string
  images?: ImageAttachment[]
}

type ThreadMessage = Pick<Message, 'id' | 'role' | 'content' | 'displayContent' | 'images'>

export function planResend(
  messages: ThreadMessage[],
  targetId: string,
  /** Edit-and-resend: the rewritten text. Undefined for a plain regenerate. */
  override?: string,
): ResendPlan | null {
  const idx = messages.findIndex((m) => m.id === targetId)
  if (idx < 0) return null
  // An edit rewrites the question itself, so its target has to BE one.
  if (override !== undefined && messages[idx].role !== 'user') return null

  // Regenerate targets the answer; walk back to the question that produced it,
  // past the tool results an agent turn leaves in between.
  let anchorIdx = messages[idx].role === 'user' ? idx : idx - 1
  while (anchorIdx >= 0 && messages[anchorIdx].role !== 'user') anchorIdx--
  if (anchorIdx < 0) return null
  const anchor = messages[anchorIdx]

  // A slash command's displayContent is literally what the user typed
  // ("/review"), so that is what goes back in — sendMessage expands it again.
  // Any other displayContent is a label, not input: the /loop driver writes
  // "pass 3 of 5" there over the instruction the model actually ran.
  const typed = anchor.displayContent?.startsWith('/') ? anchor.displayContent : anchor.content

  return {
    deleteFromId: anchor.id,
    content: override ?? typed,
    ...(anchor.images?.length ? { images: anchor.images } : {}),
  }
}
