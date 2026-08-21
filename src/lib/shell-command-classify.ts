/**
 * One classifier for what a shell command IS (read-only, commit, push, test
 * run), derived from the command text instead of a tool name.
 *
 * The 2.6.6 merge folds the twelve typed shell wrappers (git_status,
 * git_commit, run_tests, …) into shell_execute (plan section E2–E4). Four
 * behaviours used to hang on those NAMES and would silently die with them:
 * the read-only catalog for /review-style commands, the --no-verify ban, the
 * parsed summaries small models rely on, and the per-kind icon in the tool
 * block. They all hang on this file now.
 *
 * Read-only is deliberately conservative: a fixed prefix list, and any
 * chaining or substitution syntax disqualifies the command outright instead
 * of being parsed. A read-only mode that can be talked around is not one.
 */

export type ShellCommandKind =
  | 'git-status'
  | 'git-log'
  | 'git-diff'
  | 'git-commit'
  | 'git-push'
  | 'test-run'
  | 'read'
  | 'generic'

/** Chaining/substitution syntax: none of it is allowed in read-only mode. */
const CHAINING = /[;&|`]|\$\(/

/** Prefixes a reviewer may run. Kept short on purpose (plan E4 point 1). */
const READ_ONLY_PREFIXES = [
  'git status',
  'git log',
  'git diff',
  'git show',
  'git blame',
  'git branch',
  'ls',
  'cat ',
  'pwd',
]

/** A test run keeps run_tests' 300 s budget instead of the shell's 600 s. */
const TEST_RUN = /^(npm|pnpm|yarn|bun)( run)? test\b|^(npx|pnpm|yarn|bun x?) ?(vitest|jest|mocha|playwright test)\b|^(cargo|go) test\b|^pytest\b|^python3? -m pytest\b/

export function commandKind(command: string): ShellCommandKind {
  const c = command.trim()
  if (/^git\s+status\b/.test(c)) return 'git-status'
  if (/^git\s+log\b/.test(c)) return 'git-log'
  if (/^git\s+(diff|show|blame)\b/.test(c)) return 'git-diff'
  if (/^git\s+commit\b/.test(c) || (/^git\s+add\b/.test(c) && /git\s+commit\b/.test(c))) return 'git-commit'
  if (/^git\s+push\b/.test(c)) return 'git-push'
  if (TEST_RUN.test(c)) return 'test-run'
  if (isReadOnlyCommand(c)) return 'read'
  return 'generic'
}

/**
 * May this command run while the catalog is stripped to read-only
 * (Code-Review Mode, /review, /plan, /diff …)?
 */
export function isReadOnlyCommand(command: string): boolean {
  const c = command.trim()
  if (!c || CHAINING.test(c)) return false
  // Word-boundary match: `ls -la` yes, `lsof` no.
  return READ_ONLY_PREFIXES.some((p) => {
    const pt = p.trim()
    return c === pt || c.startsWith(`${pt} `)
  })
}

/**
 * The one refusal that stays hard: --no-verify on a commit. The old
 * git_commit tool could not emit it (buildGitCommitCommand never did); with
 * the model writing the command itself, the executor has to say no
 * (plan E4 point 2).
 *
 * Returns the refusal text, or null when the command may run.
 */
export function rejectShellCommand(command: string): string | null {
  const kind = commandKind(command)
  if (kind === 'git-commit' && /--no-verify\b/.test(command)) {
    return 'Refused: git commit --no-verify skips the repository hooks. Fix what the hook reports instead of silencing it, then commit normally.'
  }
  return null
}

/** Timeout for the command, in ms. A recognised test run keeps run_tests' cap. */
export const TEST_RUN_TIMEOUT_MS = 300_000

export function commandTimeoutMs(command: string, fallbackMs: number): number {
  return commandKind(command) === 'test-run' ? TEST_RUN_TIMEOUT_MS : fallbackMs
}

/**
 * The icon key for the tool block (plan E4 point 6, audit D4): derived from
 * the command so a commit still looks like a commit after the merge.
 */
export function commandIcon(command: string): string {
  switch (commandKind(command)) {
    case 'git-status':
    case 'git-log':
    case 'git-diff':
      return 'git-read'
    case 'git-commit':
      return 'git-commit'
    case 'git-push':
      return 'git-push'
    case 'test-run':
      return 'test'
    case 'read':
      return 'read'
    default:
      return 'terminal'
  }
}
