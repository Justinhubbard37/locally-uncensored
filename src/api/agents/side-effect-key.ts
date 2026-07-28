/**
 * Phase 5 (v2.4.0) — Side-effect key derivation.
 *
 * When a ReAct turn emits multiple tool calls, we want to run them
 * concurrently for speed, BUT two calls that touch the same shared
 * resource must be serialized. The scheduler groups calls by
 * sideEffectKey and runs one group in parallel but within-group in
 * sequence.
 *
 *   - Pure reads (file_read, web_fetch, web_search, system_info,
 *     process_list, file_list, file_search, get_current_time,
 *     screenshot) → no key (fully parallel-safe).
 *
 *   - file_write → key is `file_write:<normalized-path>`. Two writes to
 *     the SAME path serialize; writes to DIFFERENT paths remain parallel.
 *
 *   - shell_execute, code_execute, shell_execute_background, run_tests,
 *     git_commit, git_push → key 'exec'. We do not know what a shell command
 *     touches, and concurrent repo writes race on `.git/index.lock`, so batch
 *     all exec-class + repo-mutating calls onto a single queue. Read-only git_*
 *     (git_status/git_log/git_diff) stay parallel.
 *
 *   - image_generate, video_generate, run_workflow → key 'comfyui'. ComfyUI
 *     serializes internally and workflows do heavy I/O; running in parallel
 *     provides no win and competes for the GPU + the VRAM hand-off.
 */

export function deriveSideEffectKey(
  toolName: string,
  args: Record<string, any>
): string | undefined {
  switch (toolName) {
    case 'file_write': {
      const path = typeof args?.path === 'string' ? normalizePath(args.path) : ''
      return path ? `file_write:${path}` : 'file_write:unknown'
    }
    case 'shell_execute':
    case 'code_execute':
    case 'shell_execute_background':
    case 'run_tests':
    case 'git_commit':
    case 'git_push':
      // Everything that shells out or mutates the repo shares ONE serial queue.
      // We can't know what a command touches, and two concurrent git writes
      // (e.g. git_commit + a `git push`, or two git_commits) race on
      // `.git/index.lock` and one fails. run_tests and shell_execute_background
      // also shell out, so they must not run against a repo mid-commit. Only the
      // read-only git_* tools (git_status/git_log/git_diff) stay parallel.
      return 'exec'
    case 'image_generate':
    case 'video_generate':
    case 'run_workflow':
      // All ComfyUI work shares one GPU + one VRAM hand-off. video_generate was
      // missing here, so an image+video in the same turn ran concurrently —
      // both queued on the hand-off and a back-to-back gen could survive Stop.
      return 'comfyui'
    default:
      // file_read, file_list, file_search, web_search, web_fetch,
      // system_info, process_list, get_current_time, screenshot.
      return undefined
  }
}

function normalizePath(p: string): string {
  // Windows paths case-insensitively; Unix paths case-sensitively. Keep
  // behaviour conservative: lowercase on Windows, preserve on Unix.
  const isWindowsLike = /^[A-Za-z]:[\\\/]/.test(p) || p.startsWith('\\\\')
  let out = p.trim().replace(/\\/g, '/')
  // Collapse trailing slash so "./foo" and "./foo/" collide.
  out = out.replace(/\/+$/, '')
  // Collapse double slashes.
  out = out.replace(/\/{2,}/g, '/')
  return isWindowsLike ? out.toLowerCase() : out
}
