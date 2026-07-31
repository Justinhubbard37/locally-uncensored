/**
 * Display filter for streaming a Hermes-XML tool turn.
 *
 * The prompt-transport models answer with prose that may contain
 * `<tool_call>{...}</tool_call>` blocks. When such a turn is streamed, the
 * raw XML must never flash into the chat bubble — but everything around it
 * should appear token by token. This filter decides, per delta, which part
 * of the text is SAFE to show: it withholds the longest tail that could
 * still turn into an opening tag, and swallows everything between a
 * confirmed opening tag and its close.
 *
 * It is UI-only. The caller still accumulates the FULL raw text and runs
 * parseHermesToolCalls / stripToolCallTags on it at the end, exactly like
 * the non-streaming path — so call extraction cannot behave differently
 * just because the turn was streamed.
 */

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'

export interface HermesDisplayFilter {
  /** Feed one stream delta; returns the text that is safe to display now. */
  feed(delta: string): string
  /** Stream is over: returns whatever held-back text turned out to be prose. */
  flush(): string
  /** True while inside an unclosed <tool_call> block (UI can show a hint). */
  inToolCall(): boolean
}

/** Longest suffix of `text` that is a prefix of `tag` (possible cut tag). */
function cutTagSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1)
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len
  }
  return 0
}

export function createHermesDisplayFilter(): HermesDisplayFilter {
  let pending = ''
  let inCall = false

  return {
    feed(delta: string): string {
      pending += delta
      let out = ''
      while (true) {
        if (inCall) {
          const close = pending.indexOf(CLOSE_TAG)
          if (close === -1) {
            // Keep only what could still be part of the close tag; the call
            // body itself is never shown, so it can be dropped from pending.
            const keep = cutTagSuffix(pending, CLOSE_TAG)
            pending = keep > 0 ? pending.slice(pending.length - keep) : ''
            return out
          }
          pending = pending.slice(close + CLOSE_TAG.length)
          inCall = false
          continue
        }
        const open = pending.indexOf(OPEN_TAG)
        if (open !== -1) {
          out += pending.slice(0, open)
          pending = pending.slice(open + OPEN_TAG.length)
          inCall = true
          continue
        }
        // No full opening tag: emit everything except a tail that might
        // still become one ("<tool_ca" at the end of this delta).
        const hold = cutTagSuffix(pending, OPEN_TAG)
        out += pending.slice(0, pending.length - hold)
        pending = pending.slice(pending.length - hold)
        return out
      }
    },

    flush(): string {
      // An unfinished opening-tag prefix was ordinary prose after all. An
      // unclosed call stays swallowed — the raw-text parse at turn end is
      // what decides how a malformed call is handled, not the display.
      const rest = inCall ? '' : pending
      pending = ''
      inCall = false
      return rest
    },

    inToolCall(): boolean {
      return inCall
    },
  }
}
