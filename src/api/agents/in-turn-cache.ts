/**
 * Phase 6 (v2.4.0) — In-turn tool-result cache.
 *
 * Dedupes identical (toolName, argsHash) calls within a single agent run.
 *
 * Scope is deliberately narrow: one agent TURN (from sendAgentMessage or
 * sendInstruction start until the ReAct loop exits). We do NOT cache across
 * turns because many tools return time-sensitive data (web_search results,
 * process_list, get_current_time, file_read on a file that may have just
 * been overwritten). Scoping to a single turn keeps the semantics trivial:
 * everything inside one user prompt sees a consistent view of each tool's
 * output; the next user prompt starts fresh.
 *
 * The implementation delegates to the audit store's findCacheCandidate,
 * which indexes completed entries by (convId, toolName, argsHash, startedAt).
 * Turn start time is passed as the cut-off: anything older is treated as
 * belonging to a previous turn and ignored.
 */

import { useToolAuditStore } from '../../stores/toolAuditStore'
import type { ExecutionRequest } from './tool-executor'

export interface InTurnCacheOptions {
  convId: string
  /** Epoch ms when the current agent run started. Audit entries older than
   *  this are treated as belonging to a previous turn and not served. */
  turnStartMs: number
}

/**
 * Factory producing a `lookupCache` callback suitable for passing into
 * executeParallel's ExecutorRuntime.lookupCache. Returns the cached result
 * string when a matching prior call exists within the current turn.
 */
/**
 * Tools whose results must NEVER be served from the in-turn cache. These are
 * non-idempotent (side-effecting or state-dependent): a repeated
 * shell_execute("npm test") has to actually re-run, a file_write has to
 * actually write, and git_* reflects mutable working-tree state. Serving a
 * cached payload here silently breaks the core edit -> test -> verify loop: the
 * pre-fix test failure from an early iteration would be replayed after the fix
 * landed, and the model concludes its fix did nothing.
 */
const NON_CACHEABLE_TOOLS = new Set<string>([
  'file_write',
  'file_edit',
  'shell_execute',
  'shell_execute_background',
  'code_execute',
  'run_tests',
])

/** Reads whose cached payload is invalidated by a later workspace mutation. */
const READ_TOOLS = new Set<string>(['file_read', 'file_list'])

function isNonCacheableTool(name: string): boolean {
  return NON_CACHEABLE_TOOLS.has(name) || name.startsWith('git_')
}

/** A workspace-mutating call — same set that is non-cacheable, plus git_*. */
function isMutatingTool(name: string): boolean {
  return NON_CACHEABLE_TOOLS.has(name) || name.startsWith('git_')
}

/**
 * True when any workspace-mutating call ran after `afterMs` in this turn.
 * shell_execute can touch any path, so rather than parse an opaque shell
 * command we conservatively invalidate ALL cached reads on ANY mutation that
 * happened after the cached read. Re-reading is cheap and always correct.
 */
function hasMutationSince(convId: string, afterMs: number): boolean {
  const list = useToolAuditStore.getState().forConversation(convId)
  for (const e of list) {
    if (e.startedAt <= afterMs) continue
    if (isMutatingTool(e.toolName)) return true
  }
  return false
}

export function makeInTurnCacheLookup(opts: InTurnCacheOptions) {
  const { convId, turnStartMs } = opts
  return (req: ExecutionRequest, argsHash: string): string | undefined => {
    // Never serve non-idempotent tools from cache (see NON_CACHEABLE_TOOLS).
    if (isNonCacheableTool(req.toolName)) return undefined

    const store = useToolAuditStore.getState()
    const candidate = store.findCacheCandidate(convId, req.toolName, argsHash, turnStartMs)
    if (!candidate) return undefined

    // A cached file_read / file_list is stale the moment any mutating call ran
    // after it. Miss -> the executor re-reads the current bytes.
    if (READ_TOOLS.has(req.toolName) && hasMutationSince(convId, candidate.startedAt)) {
      return undefined
    }

    // Serve the FULL retained result, never the 500-char audit preview. When
    // the full result was not retained (absent, or clipped for size) treat it
    // as a miss so the model re-reads the whole file instead of a silently
    // truncated slice. Empty strings are a legitimate cached payload.
    if (typeof candidate.fullResult !== 'string') return undefined
    return candidate.fullResult
  }
}
