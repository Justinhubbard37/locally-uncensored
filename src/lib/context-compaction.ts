/**
 * Context Compaction — prevents "Failed to fetch" from context window exhaustion.
 *
 * Strategy:
 * - Keep the last N messages intact (recent context matters most)
 * - Summarize older messages into compact one-liners
 * - Tool call + result pairs become: "Used tool_name('args') → result_snippet"
 * - Token estimation via heuristic: text.length / 4
 */

import { getModelContext } from '../api/ollama'
import { getProviderForModel, getProviderIdFromModel } from '../api/providers'
import { useModelStore } from '../stores/modelStore'
import { truncateToolResult } from './truncate-tool-result'
import type { OllamaChatMessage } from '../types/agent-mode'

// ── Token Estimation ────────────────────────────────────────────

/**
 * Rough token estimate. Ollama models typically tokenize ~4 chars per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 1
}

/**
 * Estimate total tokens in a message array.
 */
export function estimateMessageTokens(messages: OllamaChatMessage[]): number {
  return messages.reduce((sum, m) => {
    let tokens = estimateTokens(m.content)
    // Tool calls add overhead
    if (m.tool_calls) {
      tokens += estimateTokens(JSON.stringify(m.tool_calls))
    }
    // Role tag overhead (~4 tokens)
    tokens += 4
    return sum + tokens
  }, 0)
}

// ── Model Context Lookup ────────────────────────────────────────

/**
 * Get the max context window for a model. Provider-aware.
 * Cloud models have known large context windows.
 */
export async function getModelMaxTokens(modelName: string): Promise<number> {
  try {
    const providerId = getProviderIdFromModel(modelName)

    if (providerId === 'lu-cloud') {
      // LU Cloud ships the real context_length via /models; the model store
      // carries it as contextLength. Without this branch the prefixed name
      // fell into the Ollama path → /api/show 404 → 4096 for EVERY cloud
      // model (TokenCounter pinned red at 4.1k).
      const meta = useModelStore.getState().models.find((m) => m.name === modelName)
      const ctx = meta && 'contextLength' in meta ? meta.contextLength : undefined
      if (ctx && ctx > 0) return ctx
      const { provider, modelId } = getProviderForModel(modelName)
      return await provider.getContextLength(modelId)
    }

    if (providerId === 'openai' || providerId === 'anthropic') {
      // Use provider's getContextLength for cloud models
      const { provider, modelId } = getProviderForModel(modelName)
      return await provider.getContextLength(modelId)
    }

    // Ollama: use existing endpoint
    return await getModelContext(modelName)
  } catch {
    return 4096
  }
}

// ── Message Compaction ──────────────────────────────────────────

const KEEP_RECENT = 4 // Always keep at least the last N messages untouched

/** How much of the pinned first user message survives compaction. Enough for
 * any real instruction; a pasted 200 KB file does not ride along forever. */
const PINNED_TASK_MAX_CHARS = 8000

/** How many already-done tool names the trim notice carries. */
const DONE_TRAIL_MAX = 40

/**
 * The tool names one assistant message asked for, in order.
 *
 * Two shapes, because the transports differ: the native and OpenAI paths carry
 * `tool_calls`, the hermes path carries `<tool_call>{…}</tool_call>` in the
 * content. Reading only the first `"name"` INSIDE each block matters, since a
 * tool's own arguments routinely contain a `name` field of their own.
 */
function toolNamesIn(msg: OllamaChatMessage): string[] {
  const out: string[] = []
  const calls = (msg as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls
  if (Array.isArray(calls)) {
    for (const tc of calls) {
      if (typeof tc?.function?.name === 'string') out.push(tc.function.name)
    }
  }
  if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.includes('<tool_call>')) {
    for (const block of msg.content.matchAll(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g)) {
      const m = /"name"\s*:\s*"([a-zA-Z0-9_]+)"/.exec(block[1])
      if (m) out.push(m[1])
    }
  }
  return out
}

/**
 * True for a message that is a tool RESULT — either the native `tool` role or
 * a Hermes `<tool_response>` carried on a user message. Used to trim a leading
 * orphan result whose originating tool_call fell outside the kept window.
 */
function isToolResultMessage(msg: OllamaChatMessage): boolean {
  if (msg.role === 'tool') return true
  if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('<tool_response>')) {
    return true
  }
  return false
}

/**
 * Compact a message array to fit within a token budget.
 *
 * Strategy — sliding window, lossless on whatever it keeps:
 *  - If already within budget, return messages unchanged.
 *  - Otherwise keep the system prompt + the longest recent SUFFIX that fits,
 *    VERBATIM, and DROP the oldest messages entirely (replaced by a one-line
 *    notice).
 *
 * Why not summarize? The previous implementation char-truncated every older
 * tool result to 80 chars. Inside a single autonomous coding turn that meant an
 * 80-char slice of a file the agent had read was indistinguishable from the
 * whole file — so the model edited against content it could no longer see.
 * Dropping is honest: the model re-reads with file_read when it needs the bytes
 * again, instead of trusting a lossy stub.
 */
export function compactMessages(
  messages: OllamaChatMessage[],
  maxTokens: number
): OllamaChatMessage[] {
  const currentTokens = estimateMessageTokens(messages)

  // Already within budget
  if (currentTokens <= maxTokens) return messages

  // Separate system prompt (always kept)
  const systemMsg = messages[0]?.role === 'system' ? messages[0] : null
  const nonSystem = systemMsg ? messages.slice(1) : [...messages]

  // If we have fewer messages than KEEP_RECENT, can't compact further
  if (nonSystem.length <= KEEP_RECENT) return messages

  const systemTokens = systemMsg ? estimateMessageTokens([systemMsg]) : 0
  const budget = Math.max(0, maxTokens - systemTokens)

  // Cap oversized TOOL RESULTS before fitting the suffix. KEEP_RECENT below
  // keeps the newest messages even when they exceed the budget — without this
  // cap a single giant file_read result rode along VERBATIM in every request
  // (live 2026-07-26: ~225k-token prompts against a 6.5k trim target, every
  // iteration slow and expensive). Only tool results are capped; user and
  // assistant text is never touched. The cap adapts to the budget (chars ≈
  // tokens × 4), floored so tiny budgets still keep a useful head+tail.
  const perResultCap = Math.max(4000, Math.min(32000, Math.floor(budget * 4 * 0.35)))
  const capped = nonSystem.map((m) =>
    isToolResultMessage(m) && typeof m.content === 'string' && m.content.length > perResultCap
      ? { ...m, content: truncateToolResult(m.content, perResultCap) }
      : m,
  )

  // Pin the TASK (audit C5). The oldest message is the user's actual
  // instruction, and the suffix window is precisely the mechanism that drops
  // it first — after which a 30-minute run works on whatever the recent tool
  // results imply instead of what was asked. Keep the first user message
  // (capped) out of the drop zone, alongside the system prompt.
  const firstUserIdx = capped.findIndex((m) => m.role === 'user')
  const pinnedTask =
    firstUserIdx >= 0 && typeof capped[firstUserIdx].content === 'string'
      ? {
          ...capped[firstUserIdx],
          content:
            capped[firstUserIdx].content.length > PINNED_TASK_MAX_CHARS
              ? truncateToolResult(capped[firstUserIdx].content, PINNED_TASK_MAX_CHARS)
              : capped[firstUserIdx].content,
        }
      : null
  const pinnedTokens = pinnedTask ? estimateMessageTokens([pinnedTask]) : 0

  // Accumulate a recent suffix that fits, newest-first. Keep at least
  // KEEP_RECENT messages even when that exceeds budget (recent context is the
  // most valuable), otherwise stop as soon as the next message would overflow.
  const suffixBudget = Math.max(0, budget - pinnedTokens)
  const kept: OllamaChatMessage[] = []
  let used = 0
  for (let i = capped.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens([capped[i]])
    if (used + t > suffixBudget && kept.length >= KEEP_RECENT) break
    kept.unshift(capped[i])
    used += t
  }

  // Drop leading orphan tool results (their tool_call fell outside the window)
  // so strict OpenAI-compatible providers don't reject a result with no call.
  while (kept.length > 0 && isToolResultMessage(kept[0])) {
    kept.shift()
  }

  // The pin is only needed when the first user message did NOT survive into
  // the suffix on its own.
  const pinNeeded = pinnedTask !== null && !kept.includes(capped[firstUserIdx])

  const droppedCount = capped.length - kept.length - (pinNeeded ? 1 : 0)
  const compacted: OllamaChatMessage[] = []
  if (systemMsg) compacted.push(systemMsg)
  if (pinNeeded && pinnedTask) {
    compacted.push(pinnedTask)
  }
  if (droppedCount > 0) {
    // What was dropped is exactly the record of the work already done, while
    // the pin keeps the instruction alive forever. Measured on the installed
    // build 2026-08-06, Coding + Ollama + hermes, a 30 step plan: the run
    // walked steps 1 to 18, compaction fired, and the very next call was
    // todo_write followed by get_current_time, system_info, process_list,
    // file_list. It had started the plan over from the top, because the only
    // thing it could still see was the plan itself. David watching it: "es
    // wiederholt sich die ganze Zeit ... und er sagt immer dasselbe."
    //
    // So the notice carries the trail. Names only, no arguments and no
    // results: it is the cheapest thing that answers "where was I".
    const dropped = capped.slice(0, capped.length - kept.length)
    const done: string[] = []
    for (const m of dropped) done.push(...toolNamesIn(m))
    const omitted = Math.max(0, done.length - DONE_TRAIL_MAX)
    const trail = done.slice(done.length - DONE_TRAIL_MAX)
    const doneLine = done.length
      ? ` Already done in this run, in order${omitted ? ` (${omitted} earlier call${omitted === 1 ? '' : 's'} omitted)` : ''}: ${trail.join(', ')}. Carry on AFTER the last one, do not start the task again from the beginning.`
      : ''

    // Wording matters here: the old notice ("Re-read any file you still need
    // with file_read.") actively FED a re-read loop — every iteration the
    // model was told to read again what it had just read. Keep the honest
    // recovery path but make it single-shot and anti-repeat.
    compacted.push({
      role: 'system',
      content: `[${droppedCount} earlier message${droppedCount === 1 ? '' : 's'} were trimmed to fit the context window. The original task above still stands. Results you already saw still hold.${doneLine} If a detail is genuinely missing, re-read that specific file once; never repeat a call that already ran.]`,
    })
  }
  compacted.push(...kept)
  return compacted
}
