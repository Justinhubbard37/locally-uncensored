// H2 security gate — shared, pure, testable.
//
// Consumed by BOTH loops since G15a (2026-08-07): useCodex gates on it
// directly, and useAgentChat lifts an exec tool to pending_approval when
// the cloud arm says so, on top of its per-tool permission levels. Before
// that, the same cloud model that had to ask in the Code tab ran
// shell_execute unattended on the Agent surface (R23).
//
// The coding agent (useCodex) auto-runs tools unattended by design. These are
// the arbitrary-code-execution tools — the prompt-injection RCE surface (a tool
// result or a read file steering the model into running a command). When the
// user enables `settings.codexConfirmShell`, each of these pauses for an
// explicit confirm before dispatch.
//
// file_write is deliberately NOT here: it is path-jailed to the workspace (C2)
// and has its own Stage-and-Approve mode, so it is not part of this gate.
export const CODEX_CONFIRM_TOOLS: ReadonlySet<string> = new Set([
  'shell_execute',
  'code_execute',
  'shell_execute_background',
])

/** True when this tool call must be confirmed: the gate is enabled AND the tool
 *  is one of the arbitrary-exec tools. */
export function codexNeedsConfirm(toolName: string, confirmEnabled: boolean): boolean {
  return confirmEnabled && CODEX_CONFIRM_TOOLS.has(toolName)
}

/**
 * Is the confirm gate active for THIS run? (David 2026-07-24: "auto approve bei
 * cloud modellen setting nicht funktional".)
 *
 * The 2.5.7 security review hard-wired `providerId === 'lu-cloud'` into the gate,
 * so on a cloud model every shell/code call confirmed even with the setting off.
 * The setting was silently overridden with nothing in the UI saying so, which
 * reads as a broken toggle rather than a policy.
 *
 * The policy is still the right default — a remote model reaching unattended
 * local shell is a bigger blast radius than a local model the user deliberately
 * trusts — so it stays ON by default. It is now a real, visible, user-owned
 * switch instead of a hidden override: turn `cloudConfirmShell` off and cloud
 * models follow the same rule as local ones.
 */
export function codexConfirmEnabled(opts: {
  /** settings.codexConfirmShell — confirm for EVERY provider. */
  confirmShell: boolean
  /** settings.codexCloudConfirmShell — also confirm on LU Cloud. Default true. */
  cloudConfirmShell: boolean
  /** Provider driving this run ('lu-cloud' | 'ollama' | 'openai' | ...). */
  providerId: string
}): boolean {
  if (opts.confirmShell) return true
  return opts.providerId === 'lu-cloud' && opts.cloudConfirmShell
}
