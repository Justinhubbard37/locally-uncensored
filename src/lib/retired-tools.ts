/**
 * 2.6.6 tool merge: names that no longer exist in the catalog but still
 * execute via the registry redirect (builtin-tools RETIRED_EXECUTORS).
 *
 * Standalone module on purpose: tool-registry needs this set synchronously
 * in resolveExecutable(), and importing builtin-tools there would close the
 * cycle tool-registry -> builtin-tools -> sub-agent -> tool-registry.
 * A unit test asserts this list equals the executor map's keys.
 */
import type { PermissionLevel } from '../api/mcp/types'

export const RETIRED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'git_status',
  'git_log',
  'git_diff',
  'git_commit',
  'git_push',
  'run_tests',
  'gh_pr_create',
  'project_init',
  'code_execute',
  'system_info',
  'process_list',
  'get_current_time',
  'shell_execute_background',
  'shell_task_status',
  'shell_task_kill',
  'shell_task_list',
])

/**
 * The retired names that CHANGE something. The split used to live in
 * builtin-tools as RETIRED_MUTATING, where only the read-only-turn refusal
 * could see it; A9 needs the same answer in the registry's permission lookup,
 * and two copies of a security-relevant set drift. A drift test pins that this
 * set is a subset of the names above.
 */
export const RETIRED_MUTATING_NAMES: ReadonlySet<string> = new Set([
  'git_commit',
  'git_push',
  'gh_pr_create',
  'project_init',
  'run_tests',
  'code_execute',
  'shell_execute_background',
  'shell_task_kill',
])

/**
 * Which permission category a retired name borrows now that it has no
 * definition of its own. Everything that redirects into a shell command is
 * terminal; the three that redirect into a backend probe keep the system
 * category they always had, so blocking one does not silently block the other.
 */
const RETIRED_CATEGORY: Record<string, 'terminal' | 'system'> = {
  system_info: 'system',
  process_list: 'system',
  get_current_time: 'system',
}

/** True for a retired name that only looks at things. */
export function isRetiredReadOnly(name: string): boolean {
  return RETIRED_TOOL_NAMES.has(name) && !RETIRED_MUTATING_NAMES.has(name)
}

/**
 * The permission a retired name resolves to, or undefined when the name was
 * never ours.
 *
 * A9. The registry answers 'confirm' for anything it cannot find, so every
 * retired name asked for an approval dialog in Agent mode, including
 * `git_status`, whose whole executor is one fixed `git status --porcelain=2
 * --branch`. That is a dialog for a read, on a name the model only used
 * because its own context taught it the old spelling, and the user has to
 * click it to get anywhere.
 *
 * So: read-only retired names run unattended, mutating ones keep the confirm
 * they would have had as terminal tools, and a BLOCKED category still blocks
 * both, because the redirect is not a way around a switched-off permission.
 */
export function retiredPermissionLevel(
  name: string,
  permissions: Record<string, PermissionLevel>,
): PermissionLevel | undefined {
  if (!RETIRED_TOOL_NAMES.has(name)) return undefined
  const category = RETIRED_CATEGORY[name] ?? 'terminal'
  if (permissions[category] === 'blocked') return 'blocked'
  return RETIRED_MUTATING_NAMES.has(name) ? 'confirm' : 'auto'
}
