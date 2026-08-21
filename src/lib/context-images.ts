/**
 * Old attachments stop riding along (2.6.6, plan A4).
 *
 * An image is the most expensive thing a message can carry and the only thing
 * the token estimator cannot see: `estimateMessageTokens` reads `content`, so a
 * 900 KB base64 screenshot counts as zero tokens in every budget decision we
 * make, and then gets billed as a few thousand real ones. Worse, it is carried
 * FOREVER. The plain chat rebuilds the whole history on every send, and the two
 * agent loops rebuild it on every STEP of every following turn, so one picture
 * attached on Monday is paid for again by every request for the rest of that
 * conversation.
 *
 * The rule is the same one age decay uses for tool results, applied to pixels:
 * only the newest user turns carry their attachments. Everything older keeps
 * its text and loses the bytes, with a one-line note in their place so the
 * model knows a picture existed rather than silently seeing a question about
 * nothing.
 *
 * Three properties, same as the decay module:
 *
 *  1. BUILDER ONLY. The stripping happens on the copy a request is built from.
 *     The store, the persisted conversation and the visible bubble keep the
 *     image, so the user still sees what they attached and the whole feature is
 *     one settings flip away from being off.
 *  2. POSITIONAL AND DETERMINISTIC. The keep set is "the newest N user turns",
 *     nothing derived from sizes or budgets, so the same history always yields
 *     the same bytes and the prompt prefix stays still.
 *  3. NEVER THE LIVE TURN. The message being answered is by definition among
 *     the newest user turns, so the picture the question is about is always
 *     there (plan meta-rule 4).
 */

/** How many of the newest user turns keep their attachments. */
export const IMAGE_KEEP_RECENT = 2

/** Minimal shape this module needs. Fits ChatMessage and the group wire type. */
export interface ImageMessage {
  role: string
  content?: unknown
  images?: unknown[]
  /** Set by buildVisionFeedback: the loop attached this picture itself. */
  visionFeedback?: boolean
  tool_call_id?: string
}

/**
 * What replaces a user attachment. It has to say the picture still EXISTS,
 * otherwise a model asked "what is in this image" answers that it never got
 * one, which reads as a bug to the user who can see it on screen.
 */
export function imageDropNote(count: number): string {
  const n = count === 1 ? 'An image' : `${count} images`
  const it = count === 1 ? 'it' : 'them'
  return `[${n} attached earlier in this conversation ${count === 1 ? 'is' : 'are'} not re-sent with every message. The attachment is still in the chat; ask the user to send ${it} again if you need to look at ${it}.]`
}

/** What replaces a picture the run generated and fed back to itself. */
export const GENERATED_IMAGE_DROP_NOTE =
  '[The image generated earlier in this run is not re-attached to every request. It is already shown to the user in the chat.]'

/**
 * True for a message that carries a tool RESULT rather than a user turn: the
 * native `tool` role, or a Hermes `<tool_response>` riding on a user message.
 *
 * It matters for the keep set. On the Hermes transport every tool result is a
 * user message, so counting those as user turns would push the picture the user
 * just attached out of the window after a single step of tool traffic.
 */
function carriesToolResult(msg: ImageMessage): boolean {
  if (msg.role === 'tool') return true
  if (typeof msg.tool_call_id === 'string' && msg.tool_call_id) return true
  if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('<tool_response>')) {
    return true
  }
  return false
}

export interface AgeImagesOptions {
  /** The contextDecay notaus. False sends the history exactly as before. */
  enabled?: boolean
  /** How many of the newest user turns keep their attachments. */
  keepRecent?: number
}

export interface AgedImages<T> {
  /** A fresh array. The input is never touched. */
  messages: T[]
  /** Messages whose attachments were replaced by a note. */
  strippedMessages: number
  /** Attachments left behind. */
  strippedImages: number
  /** Base64 characters kept off the wire. */
  savedChars: number
}

/**
 * Drop the attachments of every user turn older than the newest `keepRecent`.
 *
 * With the notaus off the messages come back unchanged (a copy, so the caller
 * can keep treating the result as the send array).
 */
export function ageOutImages<T extends { role: string; content?: unknown }>(
  messages: T[],
  opts: AgeImagesOptions = {},
): AgedImages<T> {
  const out = messages.slice()
  if (opts.enabled === false) {
    return { messages: out, strippedMessages: 0, strippedImages: 0, savedChars: 0 }
  }
  const keepRecent = Math.max(0, opts.keepRecent ?? IMAGE_KEEP_RECENT)

  const userTurns: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as ImageMessage
    if (m.role !== 'user' || carriesToolResult(m)) continue
    userTurns.push(i)
  }
  const keep = new Set(userTurns.slice(-keepRecent))

  let strippedMessages = 0
  let strippedImages = 0
  let savedChars = 0
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as ImageMessage
    if (m.role !== 'user' || !Array.isArray(m.images) || m.images.length === 0) continue
    if (keep.has(i)) continue

    const count = m.images.length
    for (const img of m.images) {
      const data = (img as { data?: unknown }).data
      if (typeof data === 'string') savedChars += data.length
    }
    const note = m.visionFeedback ? GENERATED_IMAGE_DROP_NOTE : imageDropNote(count)
    const text = typeof m.content === 'string' ? m.content : ''
    const next = { ...m } as ImageMessage
    delete next.images
    next.content = text.trim() ? `${text}\n\n${note}` : note
    out[i] = next as unknown as T
    strippedMessages++
    strippedImages += count
  }
  return { messages: out, strippedMessages, strippedImages, savedChars }
}
