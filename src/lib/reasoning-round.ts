/**
 * A round that is all thought is not an ending.
 *
 * Measured on R17 (Agent, Ollama, Qwen3-4B, 2026-08-07): step 1 of 31 fired,
 * the next round arrived as reasoning with no answer segment and no tool
 * call, and the loop ended the run. On Ollama's Qwen3 chat templates this is
 * not even unusual: the opening think tag lives in the PROMPT (G12), so an
 * entire round can stream as thought text.
 *
 * Three layers now stand between such a round and a dead run, in order:
 *  1. the dud-turn retry (before ANY tool ran, retry once with think off),
 *  2. the G16 plan reconcile (an open todo list contradicts the ending),
 *  3. this: mid-run, no plan to lean on, thought but no words and no call.
 */

/** True when the model produced reasoning but neither answer text nor calls. */
export function reasoningOnlyRound(content: string, thinking: string): boolean {
  return !content.trim() && !!thinking.trim()
}

/** Per-run budget. A model that reasons three rounds straight without acting
 * is stuck in its head; further pushes only spend tokens. */
export const REASONING_CONTINUE_BUDGET = 2

export const REASONING_CONTINUE_STEER =
  'Your last round was internal reasoning only, with no answer and no tool call. ' +
  'That is fine, but the task is still open: continue now. Either execute the next ' +
  'step as a tool call, or, if everything is genuinely done, state the final answer in plain text.'
