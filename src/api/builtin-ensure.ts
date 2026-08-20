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
import { AGENT_CONTEXT_CAP } from '../lib/context-window'

interface EngineStatusLite {
  running: boolean
  healthy: boolean
  /** The `--ctx-size` the chat engine was started with (ENG-3). */
  ctx?: number | null
}

interface BundledList {
  models?: Array<{ name: string; path: string; ctx_train?: number | null }>
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

// The default the engine ships with. A settings ctx equal to it is treated as
// "never touched", anything else as an explicit user choice that wins in both
// directions (see ensureBuiltinAgentCtx below).
const ENGINE_DEFAULT_CTX = 8192

// Models whose raise attempt failed once (path -> refused ctx). Without this
// a card that cannot allocate the bigger KV cache would retry the failing
// restart on every single agent turn.
const refusedCtxByPath = new Map<string, number>()

/** Test-only: forget refused raises so unit tests stay isolated. */
export function __resetAgentCtxStateForTests(): void {
  refusedCtxByPath.clear()
}

/**
 * Z36 finding 2 (W3 run 2026-08-16): an agent turn carries the full tool
 * catalogue and routinely outgrows the engine's 8192 default, while the GGUF
 * itself was trained for far more (ctx_train 32k live). llama-server's ctx is
 * a START-time flag, so unlike Ollama's per-request num_ctx somebody has to
 * restart the engine bigger, and nobody did: the prompt silently overflowed.
 *
 * This raises the managed built-in engine to the same ceiling the Ollama
 * agent path already uses: min(ctx_train, AGENT_CONTEXT_CAP), floored at the
 * 8192 default. It only ever raises, never shrinks, and only when the GGUF
 * header states the model can take it (no RoPE extrapolation on a guess).
 * A user-set engine ctx (anything other than the untouched 8192 default) or
 * a contextWindowOverride wins outright, matching resolveAgentNumCtx.
 *
 * When the raise attempt fails (a small card may not fit the bigger KV
 * cache), the engine is restarted with the previous tuning so chat survives,
 * and the (path, ctx) pair is remembered so we never retry-loop. Never
 * throws: an agent run must start even when none of this works.
 */
export async function ensureBuiltinAgentCtx(modelName: string): Promise<void> {
  if (!isManagedBuiltinSlot()) return
  const settings = useSettingsStore.getState().settings
  const tuning = settings.builtinEngine as (typeof settings.builtinEngine) | undefined
  if (tuning && typeof tuning.ctx === 'number' && tuning.ctx > 0 && tuning.ctx !== ENGINE_DEFAULT_CTX) {
    return // explicit expert choice, do not second-guess it
  }

  let status: EngineStatusLite | null
  try {
    status = await backendCall<EngineStatusLite>('bundled_engine_status')
  } catch {
    return // non-Tauri context (tests/browser)
  }

  let models: Array<{ name: string; path: string; ctx_train?: number | null }>
  try {
    const res = await backendCall<BundledList>('list_bundled_models')
    models = res?.models ?? []
  } catch {
    return
  }
  const bare = modelName.includes('::') ? modelName.split('::')[1] : modelName
  const hit = models.find((m) => m.name === bare)
  if (!hit) return

  const override = settings.contextWindowOverride
  let want = 0
  if (typeof override === 'number' && override > 0) {
    want = override
  } else if (typeof hit.ctx_train === 'number' && hit.ctx_train > 0) {
    want = Math.max(ENGINE_DEFAULT_CTX, Math.min(hit.ctx_train, AGENT_CONTEXT_CAP))
  } else {
    return // the GGUF does not state a trained context, never raise on a guess
  }

  if (refusedCtxByPath.get(hit.path) === want) return
  const current = status?.running && typeof status.ctx === 'number' && status.ctx > 0 ? status.ctx : 0
  if (current >= want) return

  const raised = { ...(tuning ?? {}), ctx: want }
  try {
    await backendCall(status?.running ? 'swap_bundled_model' : 'start_bundled_engine', {
      modelPath: hit.path,
      tuning: raised,
    })
  } catch {
    refusedCtxByPath.set(hit.path, want)
    // Fall back to the previous tuning so the chat engine is not left dead.
    try {
      await backendCall('start_bundled_engine', { modelPath: hit.path, tuning })
    } catch { /* the lazy self-heal on the next send takes over */ }
  }
}
