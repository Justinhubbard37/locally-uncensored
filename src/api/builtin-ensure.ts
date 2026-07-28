/**
 * Self-heal for the managed built-in engine (llama-server on 127.0.0.1:8127).
 *
 * The Create tab and the music/video lanes call `offload_local_models` before
 * a render to free VRAM, which STOPS the bundled chat engine — by design, with
 * the promise that it "reloads lazily on the next message". This module is
 * that lazy reload: the OpenAI provider calls it right before a send when its
 * slot is the app-managed engine (`config.managed === true`). Without it the
 * first message after a render hits a dead port, and to the user the whole
 * backend looks crashed until an app restart (RTX 5080 field report: use
 * Create/ACE-Step once → chat dead until relaunch).
 *
 * Deliberately imports only `backend` + the provider store so it can sit
 * below `api/providers` without an import cycle.
 */

import { backendCall } from './backend'
import { useProviderStore } from '../stores/providerStore'

interface EngineStatusLite {
  running: boolean
  healthy: boolean
}

interface BundledList {
  models?: Array<{ name: string; path: string }>
}

// Coalesce concurrent sends (chat + title generation) into ONE health-check /
// restart. start_bundled_engine blocks until /health is green, so awaiting the
// same promise is exactly "wait for the restart the other call kicked off".
let inflight: Promise<void> | null = null

/** True when the `openai` slot is the app-managed built-in engine. */
export function isManagedBuiltinSlot(): boolean {
  const cfg = useProviderStore.getState().providers.openai
  return !!cfg?.enabled && cfg.managed === true
}

/**
 * Make sure the built-in engine is up before a send. No-op when the slot is
 * not managed, the engine is already healthy, or `modelName` is not a bundled
 * GGUF (nothing we own to heal). Throws only when an actual restart attempt
 * fails — that error carries llama-server's stderr tail and IS the honest
 * thing to show in the chat instead of a bare "fetch failed".
 */
export async function ensureBuiltinEngineAlive(modelName: string): Promise<void> {
  if (!isManagedBuiltinSlot()) return
  if (inflight) return inflight
  inflight = (async () => {
    try {
      let status: EngineStatusLite | null
      try {
        status = await backendCall<EngineStatusLite>('bundled_engine_status')
      } catch {
        return // non-Tauri context (tests/browser) — nothing to manage
      }
      if (status?.healthy) return

      let models: Array<{ name: string; path: string }>
      try {
        const res = await backendCall<BundledList>('list_bundled_models')
        models = res?.models ?? []
      } catch {
        return
      }
      const bare = modelName.includes('::') ? modelName.split('::')[1] : modelName
      const hit = models.find((m) => m.name === bare)
      if (!hit) return // not a bundled GGUF — some other openai-compat server

      await backendCall('start_bundled_engine', { modelPath: hit.path })
    } finally {
      inflight = null
    }
  })()
  return inflight
}
