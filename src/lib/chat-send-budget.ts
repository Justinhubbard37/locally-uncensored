/**
 * The send budget for the CONVERSATION surfaces (2.6.6, plan A4).
 *
 * A2 put a ceiling on what one agent step may send. The three chat surfaces had
 * none, and two of them multiply every byte:
 *
 *  - plain chat rebuilds the full history on every send, so turn 60 of a long
 *    chat pays for turns 1 to 59 again to ask "and shorter please";
 *  - a group round sends that same full history to two to four models, so one
 *    round costs history level times N;
 *  - compare sends it to both sides of the panel, every round, uncapped.
 *
 * So all three get the A2 number: min(0.8 x model window,
 * codexSendWindowTokens) on a paid provider, and nothing at all anywhere else.
 * Local backends are byte-identical to 2.6.5 because there is no bill on the
 * other end, and the contextDecay notaus returns every surface to exactly the
 * payload it sent before, which is what makes this supportable in the field
 * without a rollback release.
 *
 * The message-COUNT cap (capMessageCount) stays where it is on every path. It
 * guards a different failure: a chat of many short turns fits every token
 * budget while the count climbs past the proxy's 400-message gate.
 */

import { compactMessages, estimateMessageTokens } from './context-compaction'
import { ageOutImages } from './context-images'
import { effectiveSendWindow, isPaidProvider } from './send-window'

export interface ChatSendBudgetInput {
  /** Provider id of the model this payload goes to. */
  providerId: string
  /** The model's context window, as getModelMaxTokens resolved it. */
  modelWindow: number
  /** settings.codexSendWindowTokens. */
  sendWindowTokens?: number
  /** settings.contextDecay. The notaus switches the whole cap off. */
  contextDecay?: boolean
}

/**
 * Whether a payload to this provider is capped at all, answerable before the
 * model window has been looked up.
 *
 * Resolving that window is an /api/show round trip on Ollama, and a local
 * backend is never capped, so it must not pay for a question whose answer
 * cannot change anything.
 */
export function chatBudgetApplies(providerId: string, contextDecay?: boolean): boolean {
  return contextDecay !== false && isPaidProvider(providerId)
}

/**
 * The budget one send may carry, or null when this surface is not capped at
 * all. Null is not "unlimited by accident": it is the explicit 2.6.5 path, and
 * callers hand the untouched array straight through on it.
 */
export function chatSendBudget(input: ChatSendBudgetInput): number | null {
  if (!chatBudgetApplies(input.providerId, input.contextDecay)) return null
  const window = effectiveSendWindow({
    providerId: input.providerId,
    modelWindow: input.modelWindow,
    sendWindowTokens: input.sendWindowTokens,
    capEnabled: true,
  })
  return window > 0 ? window : null
}

/**
 * The budget for a payload that goes to SEVERAL models at once (compare, and
 * conceptually a group round): the tightest of the applicable ones.
 *
 * Both sides of a compare have to receive the same prompt or the comparison is
 * not a comparison, so a mixed pairing takes the paid side's budget for both.
 */
export function sharedChatSendBudget(inputs: ChatSendBudgetInput[]): number | null {
  const budgets = inputs.map(chatSendBudget).filter((b): b is number => b !== null)
  return budgets.length ? Math.min(...budgets) : null
}

export interface ChatSendResult<T> {
  messages: T[]
  /** The budget that was applied, or null when the payload passed through. */
  budget: number | null
  /** Estimated size of the payload as it goes out. */
  promptTokens: number
  /** Attachments left behind by the image rule. */
  droppedImages: number
}

export interface ApplyBudgetOptions {
  /** How many of the newest user turns keep their attachments. */
  keepImages?: number
}

/**
 * Apply a resolved budget to a message array.
 *
 * Order is the same as the agent builder's: attachments first (they are the
 * bytes the token estimator cannot see), then the token budget. Compaction runs
 * with the A3 hysteresis, so a chat sitting at the ceiling keeps the same
 * prompt prefix for several turns running instead of shifting the window on
 * every single send and paying full price for the whole history again.
 */
export function applySendBudget<T extends { role: string; content?: unknown }>(
  messages: T[],
  budget: number | null,
  opts: ApplyBudgetOptions = {},
): ChatSendResult<T> {
  type Estimated = Parameters<typeof estimateMessageTokens>[0]
  if (budget === null) {
    // The untouched array, by reference: this is the 2.6.5 payload, and
    // nothing about it may change on a local backend or with the notaus off.
    return {
      messages,
      budget: null,
      promptTokens: estimateMessageTokens(messages as unknown as Estimated),
      droppedImages: 0,
    }
  }
  const aged = ageOutImages(messages, { keepRecent: opts.keepImages })
  const compacted = compactMessages(aged.messages as unknown as Estimated, budget, {
    hysteresis: true,
  }) as unknown as T[]
  return {
    messages: compacted,
    budget,
    promptTokens: estimateMessageTokens(compacted as unknown as Estimated),
    droppedImages: aged.strippedImages,
  }
}

/** Resolve the budget for one model and apply it in one call. */
export function applyChatSendBudget<T extends { role: string; content?: unknown }>(
  messages: T[],
  input: ChatSendBudgetInput & ApplyBudgetOptions,
): ChatSendResult<T> {
  return applySendBudget(messages, chatSendBudget(input), { keepImages: input.keepImages })
}
