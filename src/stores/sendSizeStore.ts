import { create } from 'zustand'

/**
 * What the last request of a conversation actually WEIGHED (2.6.6, plan A2,
 * meter honesty).
 *
 * The token counter used to divide an estimate of the visible conversation by
 * the model's full context window. On a 262k-context cloud model that reads
 * green at 25 percent forever: the red warning never fires, and a support case
 * arrives with a screenshot of a healthy meter next to a drained wallet. With
 * the send cap in place the honest denominator is the window a step may send,
 * and the honest numerator is the size of the request the builder just built.
 *
 * Ephemeral on purpose. It describes the run in front of the user, not a fact
 * worth carrying across a restart.
 */
export interface SendSizeReport {
  /** Estimated tokens of the request as it went out. */
  tokens: number
  /** The effective send window it was built against. */
  window: number
  /** Messages in the conversation when the request was built. */
  atMessageCount: number
  /** Results the age decay sent capped on this step. */
  trimmedResults: number
  /** Characters the capping saved on this step. */
  savedChars: number
}

interface SendSizeState {
  byConv: Record<string, SendSizeReport>
  report: (convId: string, size: SendSizeReport) => void
  get: (convId: string) => SendSizeReport | undefined
  clear: (convId: string) => void
}

export const useSendSizeStore = create<SendSizeState>((set, get) => ({
  byConv: {},
  report: (convId, size) =>
    set((state) => ({ byConv: { ...state.byConv, [convId]: size } })),
  get: (convId) => get().byConv[convId],
  clear: (convId) =>
    set((state) => {
      if (!(convId in state.byConv)) return state
      const next = { ...state.byConv }
      delete next[convId]
      return { byConv: next }
    }),
}))
