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
import { useSettingsStore } from '../stores/settingsStore'

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

/**
 * Rewrite a transport failure against our own engine into something a user can
 * act on. The Rust proxy reports a refused connection verbatim
 * ("proxy_localhost_stream_chunked: error sending request for url
 * (http://127.0.0.1:8127/v1/chat/completions)"), which reads like the app is
 * broken rather than like the engine is down. Only touches errors that never
 * reached an HTTP response — a real status code carries the server's own words
 * and must survive untouched.
 */
export function explainDeadEngine(err: unknown, baseUrl: string): unknown {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const isTransport = /error sending request|connection refused|failed to fetch|ECONNREFUSED|tcp connect/i.test(msg)
  if (!isTransport || !msg.includes(host.split(':')[0])) return err
  return new Error(
    `The built-in engine is not answering on ${host}. It either failed to start or was shut down. Open Settings, AI Backends, Built-in Engine and start it again, or pick a different backend. Original error: ${msg}`,
  )
}

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
      if (!hit) {
        // The slot IS our engine (managed), the engine is NOT healthy, and the
        // model the picker is holding is not on disk where the engine looks.
        // Returning quietly here sent the send straight into a dead port, and
        // the user got "proxy_localhost_stream_chunked: error sending request
        // for url (http://127.0.0.1:8127/v1/chat/completions)" as their first
        // impression of the app (applejames, Discord 2026-08-01, fresh install
        // on Windows 10 — they gave up on the built-in engine and moved to
        // Ollama). Say what is actually wrong instead.
        throw new Error(
          `The built-in engine has no model file named "${bare}". It may have been deleted, moved, or the download did not finish. Open Models, install it again, then pick it in the chat.`,
        )
      }

      // Restart with the user's expert tuning, not bare defaults — otherwise a
      // self-heal would silently drop a configured ctx/KV-quant until the next
      // manual model pick.
      const tuning = useSettingsStore.getState().settings.builtinEngine
      await backendCall('start_bundled_engine', { modelPath: hit.path, tuning })
    } finally {
      inflight = null
    }
  })()
  return inflight
}
