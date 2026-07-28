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
import { getModelMaxTokens } from './context-compaction'

/**
 * @param modelId       provider-local model id (already stripped of any prefix)
 * @param providerId    'ollama' | 'openai' | 'lu-cloud' | …
 * @param override      the user's contextWindowOverride (0 = none)
 * @param fullModelName the UNstripped model name ('lu-cloud:Qwen/…') — needed
 *                      to resolve a cloud model's real window from the catalog
 *
 * The override wins outright. Without one, Ollama models get their REAL context
 * capped for VRAM, floored at 8192 so feeding a generated image back for vision
 * feedback never overflows a 4096-default model.
 *
 * Cloud models resolve their REAL window from the model catalog. They used to
 * fall through to the flat 8192 — there is no KV-cache/VRAM cost on our side,
 * but the compaction budget derives from this value, so a 262k cloud model was
 * trimmed to ~6.5k every iteration. The model "forgot" the files it had just
 * read, the trim notice told it to re-read them, and the coding agent looped
 * on the same file_read for minutes (Morgan, 2026-07-26).
 */
export async function resolveAgentNumCtx(
  modelId: string,
  providerId: string,
  override: number | undefined,
  fullModelName?: string,
): Promise<number> {
  let ctx: number = override || 8192
  if (!override) {
    if (providerId === 'ollama') {
      try {
        ctx = Math.max(effectiveContextWindow(await getModelContextCached(modelId), 0), 8192)
      } catch { /* keep the 8192 floor on failure */ }
    } else {
      try {
        const real = await getModelMaxTokens(fullModelName ?? modelId)
        if (typeof real === 'number' && Number.isFinite(real) && real > 0) {
          ctx = Math.max(real, 8192)
        }
      } catch { /* keep the 8192 floor on failure */ }
    }
  }
  return ctx
}
