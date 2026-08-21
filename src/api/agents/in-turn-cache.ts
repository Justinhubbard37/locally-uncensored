/**
 * Phase 6 (v2.4.0) — In-turn tool-result cache.
 *
 * Dedupes identical (toolName, argsHash) calls within a single agent run.
 *
 * Scope is deliberately narrow: one agent TURN (from sendAgentMessage or
 * sendInstruction start until the ReAct loop exits). We do NOT cache across
 * turns because many tools return time-sensitive data (web_search results,
 * file_read on a file that may have just been overwritten). Scoping to a single turn keeps the semantics trivial:
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
  // Retired names (2.6.6 merge) still execute via the registry redirect and
  // must keep exactly these semantics under their old names.
  'shell_execute_background',
  'code_execute',
  'run_tests',
  // Writes the plan the user watches. Today it is idempotent, so a cache hit
  // would do no visible harm, but a write served from cache never reaches the
  // store — and a plan that silently stops updating is the one failure mode
  // that makes the whole feature untrustworthy.
  'todo_write',
])

/**
 * Of the non-cacheable tools, the ones that touch the WORKSPACE. Only these
 * invalidate a cached read.
 *
 * The two sets used to be one, which was right while every non-cacheable tool
 * also wrote to disk. todo_write broke that: it must always really run, but it
 * changes no file. Folding it into one set would throw away every cached
 * file_read on each plan update — and the plan updates after every step.
 */
const WORKSPACE_MUTATING_TOOLS = new Set<string>([
  'file_write',
  'file_edit',
  'shell_execute',
  // Redirect-era names, same reasoning as above.
  'shell_execute_background',
  'code_execute',
  'run_tests',
])

/** Reads whose cached payload is invalidated by a later workspace mutation. */
const READ_TOOLS = new Set<string>(['file_read', 'file_list'])

function isNonCacheableTool(name: string): boolean {
  // git_* covers the redirected typed git tools, reads and writes alike.
  return NON_CACHEABLE_TOOLS.has(name) || name.startsWith('git_')
}

/** A workspace-mutating call, the disk-touching subset plus redirected git_*. */
function isMutatingTool(name: string): boolean {
  return WORKSPACE_MUTATING_TOOLS.has(name) || name.startsWith('git_')
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
