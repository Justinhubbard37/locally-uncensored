/**
 * Feedback 2026-08-21 (yaserrieh@gmail.com, hosted-pro, route /): "Error:
 * [network] HTTP 400 too many messages". The plain chat path sends the WHOLE
 * conversation on every turn (unlike the agent and coding loops, which
 * compact), so once a hosted conversation crosses the server's message-count
 * limit every further turn is refused and the user is stuck in that chat
 * forever, each new message only making the payload longer.
 *
 * The server's exact limit is not knowable from the client and may change,
 * so the recovery does not guess a number: when the server answers with the
 * too-many-messages 400, the client halves the sent history (keeping the
 * system prompt and the newest half, always including the latest user turn)
 * and retries. A few halvings reach any positive limit; the conversation
 * itself is never touched, only the request shrinks.
 */

/** True for the server's message-count refusal, and nothing else. */
export function isTooManyMessagesError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /too many messages/i.test(msg)
}

/**
 * Halve the non-system history, newest half wins. Returns null once there is
 * nothing sensible left to drop (2 or fewer non-system messages), so the
 * caller stops retrying and surfaces the real error. Leading assistant/tool
 * messages after the cut are dropped so the trimmed history starts on a user
 * turn, some strict providers refuse anything else after the system prompt.
 */
export function halveHistory<T extends { role: string }>(messages: T[]): T[] | null {
  if (messages.length === 0) return null
  const system = messages[0].role === 'system' ? [messages[0]] : []
  let rest = messages.slice(system.length)
  if (rest.length <= 2) return null
  rest = rest.slice(Math.ceil(rest.length / 2))
  while (rest.length > 1 && rest[0].role !== 'user') rest.shift()
  if (rest.length === 0) return null
  return [...system, ...rest]
}

/** Retry budget: 2^5 = 32-fold shrink reaches any plausible server limit. */
export const TOO_MANY_MESSAGES_MAX_HALVINGS = 5
