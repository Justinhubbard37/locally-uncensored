// The coding agent's "may I run this" gate, as app UI instead of window.confirm.
//
// It used to be a raw `window.confirm`, which in the Tauri webview renders as an
// OS dialog: system chrome, the app origin in the title bar, the whole prompt as
// one wall of text, and no way to say "stop asking". David, 2026-07-24, on
// seeing it fire for the first time: "der dialog ist ja hässlich wie sau".
//
// A promise-bridge is what lets the same awaitApproval contract keep working:
// useCodex still awaits a boolean, the store parks the resolver, the dialog
// resolves it on click.

import { create } from 'zustand'

export interface CodexConfirmRequest {
  /** shell_execute / code_execute / shell_execute_background */
  toolName: string
  /** The command itself, already trimmed for display. */
  command: string
  /** True when the CLOUD arm is the only reason we are asking, which changes
   *  both the hint we show and which setting "don't ask again" turns off. */
  cloudReason: boolean
}

interface CodexConfirmState {
  pending: CodexConfirmRequest | null
  /** Resolver for the awaited approval. Null when nothing is pending. */
  resolve: ((allow: boolean) => void) | null
  ask: (req: CodexConfirmRequest) => Promise<boolean>
  answer: (allow: boolean) => void
}

export const useCodexConfirmStore = create<CodexConfirmState>((set, get) => ({
  pending: null,
  resolve: null,

  ask: (req) =>
    new Promise<boolean>((resolve) => {
      // A second request while one is open would strand the first resolver and
      // hang that tool call forever. Deny the older one and take the new.
      const prev = get().resolve
      if (prev) prev(false)
      set({ pending: req, resolve })
    }),

  answer: (allow) => {
    const { resolve } = get()
    set({ pending: null, resolve: null })
    resolve?.(allow)
  },
}))
