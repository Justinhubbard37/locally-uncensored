/**
 * SSE (Server-Sent Events) Stream Parser
 *
 * Parses the `data: {...}\n\n` format used by OpenAI and Anthropic APIs.
 * Companion to stream.ts which handles Ollama's NDJSON format.
 *
 * Format:
 *   data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n
 *   data: [DONE]\n\n
 *
 * Anthropic also uses event types:
 *   event: content_block_delta\n
 *   data: {"type":"content_block_delta","delta":{"text":"Hi"}}\n\n
 */

export interface SSEEvent {
  event?: string   // e.g. "content_block_delta", "message_stop"
  data: string     // raw JSON string (or "[DONE]")
}

/**
 * Parse an SSE stream into individual events.
 * Handles multi-line data fields, event types, and the [DONE] sentinel.
 */
/** One `event:`/`data:` block into an SSEEvent, or null if it carries no data. */
function parseEventBlock(block: string): SSEEvent | null {
  const trimmed = block.trim()
  if (!trimmed) return null

  let event: string | undefined
  let data = ''

  for (const line of trimmed.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      // Accumulate data lines (multi-line data support)
      if (data) data += '\n'
      data += line.slice(5).trim()
    }
    // Ignore other fields (id:, retry:, comments starting with :)
  }

  return data ? { event, data } : null
}

export async function* parseSSEStream(response: Response): AsyncGenerator<SSEEvent> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // The SSE spec allows CRLF and lone CR as line terminators, and some
      // servers and proxies use them. Splitting on '\n\n' alone glued every
      // event of such a stream into one block whose JSON never parsed — the
      // whole answer came back silently empty.
      // A trailing '\r' may be the first half of a CRLF split across two reads,
      // so it waits in the buffer until we can see what follows it.
      const carry = buffer.endsWith('\r') ? '\r' : ''
      const normalized = (carry ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n')

      // SSE events are separated by double newline
      const parts = normalized.split('\n\n')
      buffer = (parts.pop() || '') + carry

      for (const part of parts) {
        const parsed = parseEventBlock(part)
        if (parsed) yield parsed
      }
    }

    // Process any remaining buffer
    const tail = parseEventBlock(buffer.replace(/\r\n?/g, '\n'))
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

/**
 * Parse SSE stream and yield parsed JSON objects, skipping [DONE].
 */
export async function* parseSSEJsonStream<T>(response: Response): AsyncGenerator<T> {
  for await (const event of parseSSEStream(response)) {
    if (event.data === '[DONE]') return
    try {
      yield JSON.parse(event.data) as T
    } catch {
      // Skip malformed JSON
    }
  }
}

/**
 * Parse SSE stream with event types (Anthropic format).
 * Yields both the event type and parsed data.
 */
export async function* parseSSEWithEvents<T>(response: Response): AsyncGenerator<{ event?: string; data: T }> {
  for await (const event of parseSSEStream(response)) {
    if (event.data === '[DONE]') return
    try {
      yield { event: event.event, data: JSON.parse(event.data) as T }
    } catch {
      // Skip malformed JSON
    }
  }
}
