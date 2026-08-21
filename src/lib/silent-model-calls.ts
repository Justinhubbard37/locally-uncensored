/**
 * Cost policy for SILENT model calls (plan 2.6.6 A7 + R5).
 *
 * A silent call is any inference request that does NOT produce the visible
 * assistant reply: memory extraction, the memory write-decision resolution,
 * and anything a future hidden agent adds. opencode's hidden agents
 * (compaction, title, summary) are the warning example — silent model calls
 * are silent money, and on lu-cloud they are billed exactly like a chat turn.
 *
 * Two rules, defined ONCE here so every caller inherits them by construction
 * instead of each call site re-deciding:
 *
 *  1. GATE — on lu-cloud a silent call needs `settings.memoryCloudOptIn`.
 *     Default off means a cloud conversation fires NO hidden request at all.
 *     Local backends (Ollama, built-in engine, LM Studio) and BYOK keys are
 *     not gated: those calls cost the user nothing we bill for, and BYOK
 *     already has its own switch (memory settings `autoExtractInAllModes`).
 *
 *  2. MODEL — when a silent call does run on lu-cloud it runs on the cheapest
 *     suitable catalogue model, never the active one. The active model may be
 *     a flagship at ~20x the price of the entry model, and a hidden JSON
 *     extraction has no use for it. Locally the active model stays: a second
 *     local model would mean a second VRAM load, which is the expensive
 *     option there.
 *
 * This module is PURE — no stores, no providers, no network. Callers pass the
 * resolved provider id and the model list in.
 */

/**
 * lu-cloud text models ranked cheapest-first, restricted to plain instruct
 * models (no reasoner burns hidden output tokens, no vision surcharge).
 *
 * Derived from the server catalogue (`lib/chat/tier-models.ts`, wholesale
 * $/1M in + out, refreshed 2026-08-09). The first two are on EVERY plan; the
 * rest are the Pro-catalogue fallbacks for the (impossible today, possible
 * tomorrow) case that the hosted shortlist changes under us.
 *
 * NOT a pin: this list is a PREFERENCE, intersected with the models the
 * server actually serves this account right now. Nothing here is required to
 * exist — an id that vanishes from the catalogue is skipped, and if none of
 * them survive, `pickSilentCallModel` falls back to the live size heuristic
 * and finally to the active model. Prices drift daily (see the price-drift
 * guard on the server side), so treat the ORDER as the durable part.
 */
export const CHEAP_CLOUD_TEXT_MODELS: readonly string[] = [
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', // $0.02 / $0.04, hosted
  'Sao10K/L3-8B-Lunaris-v1-Turbo',               // $0.04 / $0.05, hosted
  'mistralai/Mistral-Small-3.2-24B-Instruct-2506', // $0.075 / $0.20, pro
  'meta-llama/Llama-4-Scout-17B-16E-Instruct',   // $0.10 / $0.30, pro
  'meta-llama/Llama-3.3-70B-Instruct-Turbo',     // $0.10 / $0.32, pro
]

/** Provider ids that bill against the user's LU Cloud credits. */
const METERED_PROVIDERS: ReadonlySet<string> = new Set(['lu-cloud'])

/**
 * May a silent (non-visible) model call fire on this provider?
 *
 * @param providerId  provider of the model the call would run on
 * @param cloudOptIn  `settings.memoryCloudOptIn`
 */
export function silentCallAllowed(providerId: string, cloudOptIn: boolean): boolean {
  if (!METERED_PROVIDERS.has(providerId)) return true
  return cloudOptIn === true
}

/**
 * Parameter count in billions parsed out of a model id ("…-8B-Instruct" → 8,
 * "gpt-oss-120b" → 120). The FIRST match wins, which is the total size on
 * every catalogue id that also names its active params ("Qwen3-30B-A3B" → 30).
 * Returns null when the id says nothing about size.
 *
 * Only a fallback ordering signal: the catalogue carries no price field on the
 * client (`/api/inference/v1/models` ships id, context, modalities, think and
 * tools, never $), and size is the one live, self-describing proxy for cost.
 */
export function paramSizeB(modelId: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i.exec(modelId)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/** The shape `pickSilentCallModel` needs out of the model store. */
export interface SilentCallCandidate {
  /** Prefixed store name, e.g. `lu-cloud::meta-llama/Meta-Llama-3.1-8B…`. */
  name: string
  type?: string
  provider?: string
}

const CLOUD_PREFIX = 'lu-cloud::'

/**
 * Which model a silent call should run on.
 *
 * lu-cloud → the cheapest catalogue text model that is actually available:
 * the preference list first, then the smallest model by parsed parameter
 * count, then (nothing recognisable) the active model unchanged.
 * Every other provider → the active model, unchanged.
 *
 * @param activeModel  the prefixed model the visible chat is running on
 * @param providerId   provider of `activeModel`
 * @param models       the model store's list (any non-text entries ignored)
 */
export function pickSilentCallModel(
  activeModel: string,
  providerId: string,
  models: readonly SilentCallCandidate[],
): string {
  if (!METERED_PROVIDERS.has(providerId)) return activeModel

  const available = models.filter(
    (m) =>
      typeof m.name === 'string' &&
      m.name.startsWith(CLOUD_PREFIX) &&
      (m.type === undefined || m.type === 'text'),
  )
  if (available.length === 0) return activeModel

  const ids = new Set(available.map((m) => m.name.slice(CLOUD_PREFIX.length)))
  for (const preferred of CHEAP_CLOUD_TEXT_MODELS) {
    if (ids.has(preferred)) return `${CLOUD_PREFIX}${preferred}`
  }

  // Nothing from the preference list is served — fall back to the smallest
  // model the catalogue names a size for.
  let bestId: string | null = null
  let bestSize = Infinity
  for (const id of ids) {
    const size = paramSizeB(id)
    if (size === null) continue
    if (size < bestSize) {
      bestSize = size
      bestId = id
    }
  }
  return bestId ? `${CLOUD_PREFIX}${bestId}` : activeModel
}
