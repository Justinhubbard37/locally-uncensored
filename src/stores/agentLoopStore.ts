/**
 * The currently running `/loop`, so it is never invisible.
 *
 * A loop has no built-in pass ceiling by design: if someone asks it to keep
 * going, it keeps going until it says done or they stop it. That is only
 * defensible if the user can always SEE that a loop is live, which pass it is
 * on, and stop it in one click. Hence this store and the bar it feeds.
 *
 * Runtime only — a loop does not survive a restart, and pretending otherwise
 * by persisting it would leave a dead loop on screen after a crash.
 */

import { create } from 'zustand'

export interface ActiveLoop {
  conversationId: string
  /** The pass that is about to start. */
  pass: number
  /** 0 = unlimited (settings.loopMaxPasses). */
  cap: number
  task: string
  intervalMs: number
  /** When the next pass fires, for the countdown. */
  nextAt: number
}

interface AgentLoopState {
  loop: ActiveLoop | null
  start: (loop: ActiveLoop) => void
  clear: () => void
}

export const useAgentLoopStore = create<AgentLoopState>((set) => ({
  loop: null,
  start: (loop) => set({ loop }),
  clear: () => set({ loop: null }),
}))
