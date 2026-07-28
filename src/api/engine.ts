/**
 * Built-in Engine client (2.5.7)
 *
 * Thin typed wrappers over the P1 Rust sidecar commands (see
 * `src-tauri/src/commands/engine.rs`). The built-in engine is a bundled
 * `llama.cpp` `llama-server` — OpenAI-compatible on `127.0.0.1:8127`, whose
 * lifecycle the app owns. Chat itself flows through the existing
 * `OpenAIProvider` + Rust proxy; this module only manages start/stop/swap and
 * sources the model list (the downloaded GGUFs, not just the loaded one).
 *
 * `backendCall` maps camelCase args → snake_case Rust params (Tauri).
 */

import { backendCall } from './backend'
import { prefixModelName } from './providers'
import { useProviderStore } from '../stores/providerStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { CloudModel } from '../types/models'
import type { BuiltinEngineTuning } from '../types/settings'

/** The user's Built-in Engine expert tuning (settings-backed). Injected into
 * every start/swap below, so Onboarding, Discover, the model picker and the
 * post-offload self-heal all honor it without threading it through callsites.
 * Undefined (pre-migration blob) is fine — Rust falls back to its defaults. */
function tuningFromSettings(): BuiltinEngineTuning | undefined {
  return useSettingsStore.getState().settings.builtinEngine
}

export interface BundledModel {
  /** File name without the `.gguf` extension. The id shown in the picker. */
  name: string
  /** Absolute path to the GGUF file — passed back to `swapBundledModel`. */
  path: string
  /** File size in bytes (0 if unknown). */
  size: number
  /** Whether this model is the one currently loaded by the engine. */
  loaded: boolean
}

export interface EngineStatus {
  running: boolean
  healthy: boolean
  port: number
  model_path: string | null
  /** Context size the chat engine was started with (null when not running or
   * for the embed server). The TRUE token-counter denominator. */
  ctx?: number | null
}

/** Loopback base URL of the managed embeddings server (P5). Mirrors the Rust
 * `DEFAULT_EMBED_PORT` (8128). Document-Chat/RAG POSTs `/v1/embeddings` here
 * when the built-in engine is active, instead of Ollama's `/api/embed`. */
export const EMBED_PORT = 8128
export function embedBaseUrl(): string {
  return `http://127.0.0.1:${EMBED_PORT}/v1`
}

// name → absolute GGUF path, populated by listBundledModels(). Lets callers
// activate a model by its picker id (which is what the model store carries)
// without threading the path through AIModel, which has no path field.
const pathByName = new Map<string, string>()

/**
 * True when the active OpenAI-compat backend is the app-managed built-in engine
 * (occupies the `openai` slot with `managed: true`). Drives the model-list
 * source: bundled GGUFs via `list_bundled_models`, not `/v1/models`.
 */
export function isManagedBuiltinActive(): boolean {
  const cfg = useProviderStore.getState().providers.openai
  return cfg.enabled && cfg.managed === true
}

/** Start the built-in engine with a specific GGUF. Idempotent for the same
 * model + tuning (the Rust side compares the resulting argv). */
export function startBundledEngine(modelPath: string, tuning?: BuiltinEngineTuning) {
  return backendCall('start_bundled_engine', { modelPath, tuning: tuning ?? tuningFromSettings() })
}

/** Stop the managed engine child if one is running. */
export function stopBundledEngine() {
  return backendCall('stop_bundled_engine')
}

/** Engine health + which model is loaded on which port. */
export function bundledEngineStatus() {
  return backendCall<EngineStatus>('bundled_engine_status')
}

/** Swap the loaded model (stop → start on the same port). */
export function swapBundledModel(modelPath: string, tuning?: BuiltinEngineTuning) {
  return backendCall('swap_bundled_model', { modelPath, tuning: tuning ?? tuningFromSettings() })
}

/** Start the built-in embeddings server (P5) with a specific embedding GGUF.
 * Idempotent for the same model. Runs on EMBED_PORT, separate from chat. */
export function startBundledEmbed(modelPath: string) {
  return backendCall('start_bundled_embed', { modelPath })
}

/** Stop the managed embeddings server if one is running. */
export function stopBundledEmbed() {
  return backendCall('stop_bundled_embed')
}

/** Embeddings-server health + which model is loaded on which port. */
export function bundledEmbedStatus() {
  return backendCall<EngineStatus>('bundled_embed_status')
}

// Embedding-model GGUFs: never offered in the chat dropdown, and the
// candidates for the bundled embeddings server. Single source of truth —
// useModels and the RAG self-heal below share it.
const EMBEDDING_GGUF_PATTERNS = [/embed/, /nomic-embed/, /bge-/, /e5-/, /gte-/, /sentence-/]
export function isEmbeddingGgufName(name: string): boolean {
  const lower = name.toLowerCase()
  return EMBEDDING_GGUF_PATTERNS.some((p) => p.test(lower))
}

// Coalesce concurrent RAG calls into one status-probe/restart.
let embedEnsureInflight: Promise<void> | null = null

/**
 * Revive the bundled embeddings server after a VRAM offload stopped it —
 * Create/Music renders call `offload_local_models`, which kills BOTH managed
 * sidecars with the promise of a lazy reload. This is the embed half of that
 * reload (the chat half lives in `builtin-ensure.ts`); RAG awaits it before
 * hitting :8128. Best-effort: a real start failure surfaces on the embeddings
 * request itself with the server's honest error.
 */
export async function ensureBundledEmbedAlive(): Promise<void> {
  if (embedEnsureInflight) return embedEnsureInflight
  embedEnsureInflight = (async () => {
    try {
      const status = await bundledEmbedStatus()
      if (status?.healthy) return
      const models = await listBundledModels()
      const embed = models.find((m) => isEmbeddingGgufName(m.name))
      if (embed) await startBundledEmbed(embed.path)
    } catch {
      /* best-effort — embedViaBuiltin reports the real error */
    } finally {
      embedEnsureInflight = null
    }
  })()
  return embedEnsureInflight
}

/** List downloaded GGUFs in the app models dir. Refreshes the name→path map. */
export async function listBundledModels(): Promise<BundledModel[]> {
  const res = await backendCall<{ dir: string; models: BundledModel[] }>('list_bundled_models')
  const models = res?.models ?? []
  pathByName.clear()
  for (const m of models) pathByName.set(m.name, m.path)
  return models
}

/**
 * Map bundled GGUFs to the app's model list shape. Built-in models live in the
 * `openai` slot, so they are prefixed `openai::<name>` for provider routing.
 */
export function bundledToAIModels(models: BundledModel[]): CloudModel[] {
  return models.map((m) => ({
    name: prefixModelName('openai', m.name),
    model: m.name,
    size: m.size,
    type: 'text' as const,
    provider: 'openai' as const,
    providerName: 'Built-in Engine',
  }))
}

/**
 * Activate a built-in model by its picker id (`openai::<name>` or bare `<name>`).
 * Resolves the GGUF path from the last listBundledModels() and swaps the engine.
 * No-op if the path is unknown (list not yet fetched).
 */
export async function activateBuiltinModel(nameOrPrefixed: string, tuning?: BuiltinEngineTuning): Promise<boolean> {
  const name = nameOrPrefixed.includes('::') ? nameOrPrefixed.split('::')[1] : nameOrPrefixed
  const path = pathByName.get(name)
  if (!path) return false
  await swapBundledModel(path, tuning)
  return true
}
