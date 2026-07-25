/**
 * The num_ctx an agent turn runs with — resolved in ONE place because every
 * request that touches the SAME Ollama model must send the SAME value.
 *
 * Ollama allocates the KV cache at load time and RELOADS the model whenever
 * num_ctx changes between requests. Captured off the wire on the ship exe
 * (2026-07-25): the chat request went out with `num_ctx: 32768` and the memory
 * extraction that follows EVERY agent turn went out with no options at all, so
 * Ollama threw away the 32k allocation and reloaded the model at its own
 * default. `ollama ps` then reported `context_length: 4096` while LU's own bar
 * still said "ctx 32K", and each turn paid for two model loads instead of one.
 *
 * So: same model, same num_ctx, no reload. Callers that talk to a different
 * model (a dedicated small extraction model, say) are free to resolve their own.
 */

import { getModelContextCached } from '../api/ollama'
import { effectiveContextWindow } from './context-window'

/**
 * @param modelId    provider-local model id (already stripped of any prefix)
 * @param providerId 'ollama' | 'openai' | 'lu-cloud' | …
 * @param override   the user's contextWindowOverride (0 = none)
 *
 * The override wins outright. Without one, Ollama models get their REAL context
 * capped for VRAM, floored at 8192 so feeding a generated image back for vision
 * feedback never overflows a 4096-default model.
 */
export async function resolveAgentNumCtx(
  modelId: string,
  providerId: string,
  override: number | undefined,
): Promise<number> {
  let ctx: number = override || 8192
  if (providerId === 'ollama' && !override) {
    try {
      ctx = Math.max(effectiveContextWindow(await getModelContextCached(modelId), 0), 8192)
    } catch { /* keep the 8192 floor on failure */ }
  }
  return ctx
}
