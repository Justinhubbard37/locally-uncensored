/**
 * G25 (R17c witness 2026-08-07): backend detection resolves asynchronously a
 * few seconds after startup, so the "Multiple backends running" selector could
 * open MID RUN and stand over the chat for the rest of a 20 minute agent run.
 * Detection is a startup convenience; an active run is the one thing on screen
 * the user is actually watching. Any modal it wants to open waits here until
 * every surface is idle.
 */
import { useGenerationStore } from '../stores/generationStore'
import { useCodexStore } from '../stores/codexStore'

/**
 * Pure verdict over the two run signals: the per-conversation generating
 * flags (Chat + Agent share them) and the Coding Agent's per-thread status.
 * Exported for the unit tests.
 */
export function anyRunActive(
  generating: Record<string, boolean>,
  threads: Record<string, { status: string }>,
): boolean {
  if (Object.values(generating).some(Boolean)) return true
  return Object.values(threads).some((t) => t.status === 'running')
}

function busy(): boolean {
  return anyRunActive(
    useGenerationStore.getState().generating,
    useCodexStore.getState().threads,
  )
}

/**
 * Call `show` now when no run is active, otherwise the moment the last run
 * ends. Returns a cancel function that withdraws a still-deferred `show`
 * without firing it; after `show` ran, cancelling is a no-op. Neither store
 * persists a running flag across a restart (generationStore is ephemeral by
 * design, codexStore persists only the working directory), so a crash can
 * never leave this waiting on a ghost run.
 */
export function whenRunsIdle(show: () => void): () => void {
  if (!busy()) {
    show()
    return () => {}
  }
  let done = false
  const unsubs: (() => void)[] = []
  const check = () => {
    if (done || busy()) return
    done = true
    for (const u of unsubs) u()
    show()
  }
  unsubs.push(useGenerationStore.subscribe(check))
  unsubs.push(useCodexStore.subscribe(check))
  return () => {
    done = true
    for (const u of unsubs) u()
  }
}
