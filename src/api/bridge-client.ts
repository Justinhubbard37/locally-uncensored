/**
 * lu-bridge media client (macOS Apple-Silicon MLX local media).
 *
 * Hard rule: Mac local image/video is MLX-via-lu-bridge only, never ComfyUI.
 * The bundled `lu-bridge` sidecar (spawned by `start_media_bridge`, see
 * src-tauri/src/commands/bridge.rs) serves `/cmd/:name` on 127.0.0.1:47711 with
 * NO auth (loopback bind IS the boundary). This is the single transport the
 * MLX image/video API wrappers use — the desktop analogue of the web app's
 * `backendCall` (which POSTs to the same `/cmd/*` on a paired bridge URL).
 */
import { localFetch, backendCall, isTauri } from './backend'

const BRIDGE_BASE = 'http://127.0.0.1:47711'

// Memoized "ensure the sidecar is up" promise. `start_media_bridge` is
// idempotent (no-op if already healthy), so we only pay the spawn+health-wait
// once per session; a failure clears the memo so the next call retries.
// In a plain browser (Vite dev, no Tauri invoke) we assume the bridge runs
// externally — mirroring the web app, where it's a separately-launched daemon.
let _bridgeReady: Promise<void> | null = null

export function ensureMediaBridge(): Promise<void> {
  if (!isTauri()) return Promise.resolve()
  if (!_bridgeReady) {
    _bridgeReady = backendCall('start_media_bridge')
      .then(() => undefined)
      .catch((e) => {
        _bridgeReady = null
        throw e
      })
  }
  return _bridgeReady
}

/**
 * POST a bridge command. Ensures the sidecar is running first, then proxies
 * the call to `127.0.0.1:47711/cmd/<command>` through `localFetch` (Tauri Rust
 * proxy → bypasses CORS). `timeoutMs` defaults to 30 s for status/catalog
 * calls; generation calls (a single long-blocking request) pass a large value.
 */
export async function bridgeCmd<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<T> {
  await ensureMediaBridge()
  const res = await localFetch(`${BRIDGE_BASE}/cmd/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
    timeoutMs,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string }
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}
