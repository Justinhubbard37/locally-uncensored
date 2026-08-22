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
  /** Estimated tokens of the MESSAGES of the request as they went out. */
  tokens: number
  /**
   * Estimated tokens of the serialized tool catalog that rode with them.
   *
   * The catalog is not a message, it is its own field on the wire, so the
   * message estimate never saw it and the meter read about 1.700 tokens low on
   * every coding step (the honest Ollama estimate and the model's own reported
   * usage both include it, and the built anchor was overwriting both with the
   * incomplete number). Zero on the prompt-transport path, where the catalog
   * lives inside the system message and the message estimate already has it.
   */
  toolsTokens: number
  /** The effective send window it was built against. */
  window: number
  /** Messages in the conversation when the request was built. */
  atMessageCount: number
  /** Results the age decay sent capped on this step. */
  trimmedResults: number
  /** Characters the capping saved on this step. */
  savedChars: number
}

/**
 * What the builder can report on its own. The catalog is chosen further down
 * the step, so it arrives separately through reportTools.
 */
export type BuiltSizeReport = Omit<SendSizeReport, 'toolsTokens'>

interface SendSizeState {
  byConv: Record<string, SendSizeReport>
  report: (convId: string, size: BuiltSizeReport) => void
  /** The catalog this step is sending, once the router has picked it. */
  reportTools: (convId: string, toolsTokens: number) => void
  get: (convId: string) => SendSizeReport | undefined
  clear: (convId: string) => void
}

export const useSendSizeStore = create<SendSizeState>((set, get) => ({
  byConv: {},
  // The catalog of the step before carries over instead of being reset to zero
  // here. The router runs between the two calls and may await an embedding, so
  // resetting would make the meter dip by the whole catalog for as long as that
  // takes, once per step.
  report: (convId, size) =>
    set((state) => ({
      byConv: {
        ...state.byConv,
        [convId]: { toolsTokens: state.byConv[convId]?.toolsTokens ?? 0, ...size },
      },
    })),
  reportTools: (convId, toolsTokens) =>
    set((state) => {
      const prior = state.byConv[convId]
      // Nothing to attach it to: the build threw and the meter is back on the
      // model's own usage, which counts the catalog itself.
      if (!prior) return state
      return { byConv: { ...state.byConv, [convId]: { ...prior, toolsTokens } } }
    }),
  get: (convId) => get().byConv[convId],
  clear: (convId) =>
    set((state) => {
      if (!(convId in state.byConv)) return state
      const next = { ...state.byConv }
      delete next[convId]
      return { byConv: next }
    }),
}))
