// Which machine the agent is standing on, and the one line of prompt that says
// so.
//
// This replaces the desktop_open and app_launch tools (removed 2026-08-06).
// Those were wrappers around `open` / `explorer` / `xdg-open`, which is the
// anti-pattern Anthropic names outright in "Writing effective tools for AI
// agents": tools that merely wrap existing software functionality. No competitor
// ships one either; Claude Code, Cline and the rest use a single shell tool.
// They also cost ~478 tokens of every system prompt on a registry where the
// full tool set already does not fit a 4k-context local model, so they hurt
// exactly the models they were meant to help. And they bought no safety:
// shell_execute sits behind the same confirmation gate.
//
// The one real thing they gave a weak model was not having to guess between
// `open` and `explorer`. That is a prompt problem, and this is the fix: ~60
// tokens that also spare the agent a system_info round trip and improve every
// other shell task, not just opening a folder.

export type HostPlatform = 'macos' | 'windows' | 'linux' | 'unknown'

interface NavLike {
  platform?: string
  userAgent?: string
}

function currentNav(): NavLike {
  return typeof navigator === 'undefined' ? {} : navigator
}

/** Injectable so every branch is testable from one machine. */
export function hostPlatform(nav: NavLike = currentNav()): HostPlatform {
  const plat = nav.platform || ''
  const ua = nav.userAgent || ''
  const both = `${plat} ${ua}`
  if (/Mac|iPhone|iPad|iPod|Macintosh/.test(both)) return 'macos'
  if (/Win/.test(both)) return 'windows'
  if (/Linux|X11|CrOS/.test(both)) return 'linux'
  return 'unknown'
}

/**
 * The platform sentence for the agent system prompt.
 *
 * It names the OS, the shell shell_execute will actually use, and the three
 * desktop verbs a model would otherwise guess at. Kept to one line per platform
 * because the models that need it most are the ones with the least room.
 */
export function platformPromptLine(p: HostPlatform = hostPlatform()): string {
  switch (p) {
    case 'macos':
      return 'This machine runs macOS and shell_execute runs bash. Open a file or folder with `open <path>`, reveal it in Finder with `open -R <path>`, start an application with `open -a "<App Name>"`.'
    case 'windows':
      return 'This machine runs Windows and shell_execute runs PowerShell. Open a file or folder with `Invoke-Item <path>`, reveal it in Explorer with `explorer "/select,<path>"` (one argument, the comma matters), start an application with `Start-Process "<App Name>"`.'
    case 'linux':
      return 'This machine runs Linux and shell_execute runs bash. Open a file or folder with `xdg-open <path>`, start an application with `gtk-launch <name>`. There is no reveal, so open the containing folder instead.'
    default:
      // Never invent a platform: a wrong incantation is worse than none, and
      // system_info is still there for the agent that really needs to know.
      return 'The operating system of this machine is unknown. Call system_info before running a platform-specific command.'
  }
}
