/**
 * 2.6.6 tool merge: names that no longer exist in the catalog but still
 * execute via the registry redirect (builtin-tools RETIRED_EXECUTORS).
 *
 * Standalone module on purpose: tool-registry needs this set synchronously
 * in resolveExecutable(), and importing builtin-tools there would close the
 * cycle tool-registry -> builtin-tools -> sub-agent -> tool-registry.
 * A unit test asserts this list equals the executor map's keys.
 */
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
