// A turn that outlived the hook instance which started it (G29).
//
// The chat view unmounts on a view switch. useAgentChat already knows this and
// parks its /loop timer at module scope for exactly that reason (audit A3), but
// the run's own "am I running" state is still per instance: useState(false) in
// the remounted hook, while the old closure keeps going with its own controller.
//
// The two halves of the UI then disagree, because they read different sources:
// the three dots and the clock read the PER-CONVERSATION store flag, which the
// old run set and has not cleared, so the chat looks busy. Send vs Stop reads
// the hook's own state, which is false after the remount, so the composer
// offers Send. On the Mac run of 2026-08-07 that left a conversation with an
// animating clock, no request on the wire and no Stop button: no way back.
//
// The store already knows how to end such a run. The aborter the run registered
// closes over ITS AbortController, so it survives the remount, and
// abortConversation() calls it and clears the flag.

/**
 * True when the store says this conversation is generating but no run in the
 * current hook instance accounts for it.
 */
export function isOrphanRun(
  storeGenerating: boolean,
  localGenerating: boolean,
  localAgentRunning: boolean,
): boolean {
  return storeGenerating && !localGenerating && !localAgentRunning
}
