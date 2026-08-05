/**
 * Consume one provider.chatStream turn into the same result shape that
 * chatWithTools returns, while feeding live callbacks along the way.
 *
 * This is the shared piece of the 2.6.0 streaming normalisation (David
 * 2026-07-31): Code and Agent mode used to stream only on the Ollama
 * transport and sat silent on every other provider until the whole call
 * returned. Every transport now goes through chatStream — tool defs travel
 * in ChatOptions.tools, tool-call deltas accumulate inside the provider and
 * arrive on the done chunk.
 *
 * Callbacks receive the CUMULATIVE text first (what the existing UI paths
 * paint directly) and the raw delta second (what the Hermes display filter
 * feeds on).
 */

import type {
  ChatMessage,
  ChatOptions,
  ProviderClient,
  ToolCall,
} from '../api/providers/types'

export interface StreamedProviderTurn {
  content: string
  toolCalls: ToolCall[]
  thinking: string
  promptEvalCount?: number
  evalCount?: number
  finishReason?: string
}

export async function streamProviderTurn(
  provider: ProviderClient,
  model: string,
  messages: ChatMessage[],
  options: ChatOptions,
  onContent?: (full: string, delta: string) => void,
  onThinking?: (full: string, delta: string) => void,
): Promise<StreamedProviderTurn> {
  let content = ''
  let thinking = ''
  const turn: StreamedProviderTurn = { content: '', toolCalls: [], thinking: '' }
  for await (const chunk of provider.chatStream(model, messages, options)) {
    if (chunk.content) {
      content += chunk.content
      onContent?.(content, chunk.content)
    }
    if (chunk.thinking) {
      thinking += chunk.thinking
      onThinking?.(thinking, chunk.thinking)
    }
    if (chunk.done) {
      if (chunk.toolCalls?.length) turn.toolCalls = chunk.toolCalls
      turn.promptEvalCount = chunk.promptEvalCount
      turn.evalCount = chunk.evalCount
      turn.finishReason = chunk.finishReason
    }
  }
  turn.content = content
  turn.thinking = thinking
  return turn
}
