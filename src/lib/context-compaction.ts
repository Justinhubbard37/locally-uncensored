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

  // Accumulate a recent suffix that fits, newest-first. Keep at least
  // KEEP_RECENT messages even when that exceeds budget (recent context is the
  // most valuable), otherwise stop as soon as the next message would overflow.
  const kept: OllamaChatMessage[] = []
  let used = 0
  for (let i = capped.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens([capped[i]])
    if (used + t > budget && kept.length >= KEEP_RECENT) break
    kept.unshift(capped[i])
    used += t
  }

  // Drop leading orphan tool results (their tool_call fell outside the window)
  // so strict OpenAI-compatible providers don't reject a result with no call.
  while (kept.length > 0 && isToolResultMessage(kept[0])) {
    kept.shift()
  }

  const droppedCount = capped.length - kept.length
  const compacted: OllamaChatMessage[] = []
  if (systemMsg) compacted.push(systemMsg)
  if (droppedCount > 0) {
    // Wording matters here: the old notice ("Re-read any file you still need
    // with file_read.") actively FED a re-read loop — every iteration the
    // model was told to read again what it had just read. Keep the honest
    // recovery path but make it single-shot and anti-repeat.
    compacted.push({
      role: 'system',
      content: `[${droppedCount} earlier message${droppedCount === 1 ? '' : 's'} were trimmed to fit the context window. Results you already saw still hold. If a detail is genuinely missing, re-read that specific file once; never repeat a call that already ran.]`,
    })
  }
  compacted.push(...kept)
  return compacted
}
