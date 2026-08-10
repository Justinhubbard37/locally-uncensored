// The HTTP status of a failed model call, whichever field happens to carry it.
//
// ProviderError (api/providers/types.ts) stores it as `status`; the Ollama
// streaming path (lib/ollama-stream-tools.ts) tags its plain Error with
// `statusCode`. A guard that reads only one of the two is dead on the other
// transport, and both are on the hot path of every run.
//
// That is exactly what happened (Morgan, 2026-08-10): the agent's rule "never
// retry a deterministic 4xx" read `statusCode`, so on the cloud path an
// out-of-credits refusal was retried twice with backoff before anything was
// shown, and a dying run looked like work for another 4.5 seconds.

export function httpStatusOf(err: unknown): number {
  if (!err || typeof err !== 'object') return 0
  const e = err as { status?: unknown; statusCode?: unknown }
  const raw = typeof e.status === 'number' ? e.status : e.statusCode
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

/**
 * Is retrying this failure pointless? True for a deterministic client error:
 * the same request will be refused the same way, so the run must stop and say
 * so instead of burning seconds on backoff.
 *
 * 429 is the exception that makes this worth a function. LU Cloud answers 429
 * for three different things: the per-user burst guard, an upstream provider
 * throttle (both genuinely transient, both send retry-after), and an empty
 * wallet, which no amount of waiting fixes. Only the last one is terminal, and
 * it is the only one that carries `code: 'credits_exhausted'`.
 */
export function isTerminalModelError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'credits_exhausted') return true
  const status = httpStatusOf(err)
  return status >= 400 && status < 500 && status !== 429
}
