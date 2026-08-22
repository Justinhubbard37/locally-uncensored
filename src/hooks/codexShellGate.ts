// H2 security gate: shared, pure, testable.
//
// Consumed by BOTH loops since G15a (2026-08-07): useCodex gates on it
// directly, and useAgentChat lifts an exec tool to pending_approval when
// the cloud arm says so, on top of its per-tool permission levels. Before
// that, the same cloud model that had to ask in the Code tab ran
// shell_execute unattended on the Agent surface (R23).
//
// The coding agent (useCodex) auto-runs tools unattended by design. These are
// the arbitrary-code-execution tools, the prompt-injection RCE surface (a tool
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
 * Is the confirm gate active for THIS run?
 *
 * David 2026-08-22, replacing G15a (2026-08-07) and the 2.5.9 default:
 * bypass means bypass, on a cloud model too. The 2.5.7 review hard-wired
 * `providerId === 'lu-cloud'` into the gate, 2.5.9 turned that into a visible
 * setting that still defaulted ON, and G15a carried it to the Agent surface.
 * All three kept asking a user who had just said do not ask, which reads as a
 * broken switch rather than a policy. Picking Bypass IS the decision, and the
 * customer who picks it makes it themselves.
 *
 * What stays is the opt-in: `codexCloudConfirmOptIn` is OFF by default, so a
 * cloud model behaves exactly like a local one. Turn it on and the cloud
 * confirm is back in every mode, Bypass included, because that is what opting
 * in means.
 */
export function codexConfirmEnabled(opts: {
  /** settings.codexConfirmShell: confirm for EVERY provider. */
  confirmShell: boolean
  /** settings.codexCloudConfirmOptIn: also confirm on LU Cloud. Default false. */
  cloudOptIn: boolean
  /** Provider driving this run ('lu-cloud' | 'ollama' | 'openai' | ...). */
  providerId: string
}): boolean {
  if (opts.confirmShell) return true
  // `=== true` on purpose: a profile the persist merge never touched carries
  // the key as undefined, and the new policy is what undefined must mean.
  return opts.providerId === 'lu-cloud' && opts.cloudOptIn === true
}
