/**
 * Effective context-window resolution — single source of truth so the value we
 * SEND to the model (Ollama `num_ctx`) and the value we DISPLAY (TokenCounter
 * denominator) can never disagree (David 2026-06-05: "muss immer stimmen").
 *
 * Leaf module — imports NOTHING from api/* so it can be used by both the
 * provider layer and the UI without an import cycle.
 *
 * Why a cap and not the model's full trained context:
 *  - Ollama allocates the KV cache for `num_ctx` at load time. A model may
 *    advertise a 128k–256k context, but allocating that much KV cache OOMs
 *    consumer GPUs instantly. Ollama's own default (2048) is the opposite
 *    failure: it silently truncates every real chat.
 *  - 16384 is the balance: 8× Ollama's default (no silent truncation for
 *    normal chats/RAG), yet a modest KV footprint that fits a 12 GB card.
 *  - Power users who know their VRAM set `contextWindowOverride` in Settings;
 *    that wins and can go all the way to the model's real maximum.
 */
export const DEFAULT_CONTEXT_CAP = 16384

/**
 * The cap for a turn that carries the TOOL CATALOGUE, which is every Agent and
 * Coding turn. A chat turn starts with a persona and a question. An agent turn
 * starts with every tool definition, in every round, and only then gets to the
 * work.
 *
 * Measured on the installed 2.6.2 build, 2026-08-06, Coding + Ollama + hermes:
 * the 30 builtin tools are 35087 characters of system prompt, and Ollama's own
 * `prompt_eval_count` put system plus user at 8488 tokens before a single
 * output token. Against DEFAULT_CONTEXT_CAP that is 52% of the window gone at
 * rest, so a run reached step 18 of a 30 step plan, compacted, and started the
 * plan again from step 1 because the pinned task survives compaction and the
 * progress does not. Twice, same shape both times.
 *
 * Why raising it is safe, measured on the RTX 3060 12 GB the cap was written
 * for, qwen2.5-coder:14b:
 *   num_ctx 16384 -> 12 GB, `ollama ps` reports 16%/84% CPU/GPU
 *   num_ctx 32768 -> 15 GB, `ollama ps` reports 34%/66% CPU/GPU
 * Neither OOMs. Ollama offloads layers to system RAM instead of failing, so
 * the cap was never buying the crash protection its comment promises. It buys
 * speed. For a chat that is the right trade and DEFAULT_CONTEXT_CAP keeps it.
 * For an agent run it is the wrong one: a slower run finishes, a run that
 * restarts its own plan at step 18 never does.
 *
 * The model's real maximum still wins downward, and a user override still wins
 * outright. Switching between a chat and an agent conversation on the same
 * model now changes num_ctx and costs one Ollama reload, which is the price of
 * the two surfaces having genuinely different needs. Within a run the value is
 * constant, which is the invariant `resolveAgentNumCtx` exists to hold.
 */
export const AGENT_CONTEXT_CAP = 32768

/**
 * @param modelMax   the model's real/trained context length (0/undefined = unknown)
 * @param override   user's explicit contextWindowOverride (0 = no override)
 * @param cap        the ceiling to apply (DEFAULT_CONTEXT_CAP for chat,
 *                   AGENT_CONTEXT_CAP for a turn carrying the tool catalogue)
 * @returns the context window to actually use — never exceeds the model's real
 *          max (when known), never silently sits at Ollama's 2048 default.
 */
export function effectiveContextWindow(
  modelMax: number | undefined,
  override?: number,
  cap: number = DEFAULT_CONTEXT_CAP,
): number {
  if (override && override > 0) return override
  // An UNKNOWN real maximum falls back to the conservative default, never to
  // `cap`. Asking a model for more room than it was trained on makes Ollama
  // extrapolate RoPE and costs quality, so the larger agent ceiling is only
  // ever reached by a model that has told us it can take it.
  const max = modelMax && modelMax > 0 ? modelMax : DEFAULT_CONTEXT_CAP
  return Math.min(max, cap)
}
