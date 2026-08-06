/**
 * Tools that can change something outside the conversation.
 *
 * Two things strip these from a turn's catalog: Code-Review Mode, and a
 * read-only slash command (/review, /plan, /diff, /explain, /find, /todo,
 * /security). Read-only inspectors stay — git_status / git_log / git_diff,
 * shell_task_status / shell_task_list, file_read / file_list / file_search —
 * so the agent can still do the looking the command asked for.
 *
 * Shared between useCodex and useAgentChat so the same command behaves the same
 * in the Code tab and in Agent mode. It lived only in useCodex until 2.5.9,
 * which is part of why the flag was decorative in the first place.
 */
export const MUTATING_TOOLS = new Set([
  'file_write',
  'file_edit',
  'shell_execute',
  'code_execute',
  'shell_execute_background',
  'shell_task_kill',
  'git_commit',
  'git_push',
  'project_init',
  'gh_pr_create',
  'run_tests',
  'image_generate',
  'video_generate',
  'run_workflow',
  'delegate_task',
  'screenshot',
])
