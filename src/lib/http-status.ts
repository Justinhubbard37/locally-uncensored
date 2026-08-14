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
 * "Deterministic" is about the request, not about the status number, and three
 * 4xx codes are not:
 *
 * 429 is the one that makes this worth a function. LU Cloud answers it for
 * three different things: the per-user burst guard, an upstream provider
 * throttle (both genuinely transient, both send retry-after), and an empty
 * wallet, which no amount of waiting fixes. Only the last one is terminal, and
 * it is the only one that carries `code: 'credits_exhausted'`.
 *
 * 408 is a request timeout, which is the definition of worth another try.
 *
 * 401 depends on WHOSE credential it is. For a provider the user configured
 * with an API key, a refusal is final until they fix the key. LU Cloud does
 * not work that way: its bearer is a Supabase access token that lives about an
 * hour and is re-minted per call by LuCloudProvider.delegate(), so a 401 in
 * the middle of a long agent run usually means nothing worse than "that token
 * just aged out". The retry calls delegate() again, getSession() hands back a
 * fresh token, and the user never learns it happened. Treating it as terminal
 * ended the run at the first refusal with "unauthenticated", or worse with
 * "Invalid API key, check Settings > Providers" for a provider that has no API
 * key field. api/cloud/jobs.ts states the same policy for the same cloud, with
 * the same reason: a failed lazy refresh must not tell a signed-in user to
 * sign in. When the session really is gone, getAccessToken() returns nothing
 * and the provider throws `signed_out`, which IS terminal, so the dead end
 * costs one backoff and then says the true thing.
 */
export function isTerminalModelError(err: unknown): boolean {
  const e = err as { code?: unknown; provider?: unknown } | null
  if (e?.code === 'credits_exhausted' || e?.code === 'signed_out') return true
  const status = httpStatusOf(err)
  if (status === 429 || status === 408) return false
  if (status === 401 && e?.provider === 'lu-cloud') return false
  return status >= 400 && status < 500
}
