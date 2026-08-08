/**
 * One cloud shell policy for both surfaces (G15a, decided 2026-08-07): the
 * Code tab confirms shell_execute / code_execute / shell_execute_background on
 * an LU Cloud model, and R23 proved Agent mode ran the same tools on the same
 * model unattended. Agent now lifts an exec tool to pending_approval when the
 * shared gate's cloud arm says so, on top of its per-tool permission levels.
 *
 * Run: npx vitest run src/hooks/__tests__/agent-shell-gate.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { CODEX_CONFIRM_TOOLS, codexConfirmEnabled } from '../codexShellGate'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')
const agent = read('../useAgentChat.ts')

describe('the shared policy, as Agent mode consumes it', () => {
  const agentArm = (providerId: string, cloudConfirmShell: boolean) =>
    codexConfirmEnabled({ confirmShell: false, cloudConfirmShell, providerId })

  it('a cloud model must ask before running local shell', () => {
    expect(agentArm('lu-cloud', true)).toBe(true)
  })

  it('NEGATIVE CONTROL: a local model the user chose to trust stays unattended', () => {
    expect(agentArm('ollama', true)).toBe(false)
    expect(agentArm('openai', true)).toBe(false)
  })

  it('NEGATIVE CONTROL: the visible switch really turns it off', () => {
    expect(agentArm('lu-cloud', false)).toBe(false)
  })

  it('only the arbitrary-exec tools are gated, never the jailed file tools', () => {
    expect(CODEX_CONFIRM_TOOLS.has('shell_execute')).toBe(true)
    expect(CODEX_CONFIRM_TOOLS.has('code_execute')).toBe(true)
    expect(CODEX_CONFIRM_TOOLS.has('shell_execute_background')).toBe(true)
    expect(CODEX_CONFIRM_TOOLS.has('file_write')).toBe(false)
    expect(CODEX_CONFIRM_TOOLS.has('web_fetch')).toBe(false)
  })
})

describe('wiring in useAgentChat', () => {
  it('the cloud arm rides ON TOP of the permission level, never replaces it', () => {
    expect(agent).toContain("const needsApproval = permLevel !== 'auto' || cloudShellConfirm")
  })

  it('the gate reads the SAME shared helper and setting as the Code tab', () => {
    expect(agent).toContain("import { CODEX_CONFIRM_TOOLS, codexConfirmEnabled } from './codexShellGate'")
    expect(agent).toContain('cloudConfirmShell: settings.codexCloudConfirmShell')
    expect(agent).toContain('CODEX_CONFIRM_TOOLS.has(tc.function.name)')
  })

  it('a gated call lands in the EXISTING approval flow, not a new dialog', () => {
    // pending_approval blocks enqueue through waitForApproval; the gate only
    // flips needsApproval, so the run pauses in the same inline approve UI.
    expect(agent).toContain("status: needsApproval ? 'pending_approval' : 'running'")
    // The conversation id joined the call with G29b (the queue moved to module
    // scope so an approval survives the view being torn down); the gate itself
    // still goes through this one flow.
    expect(agent).toContain('await waitForApproval(convId!, entry.ac, abort.signal)')
  })

  it('NEGATIVE CONTROL: the Codex side of the gate is untouched', () => {
    const codex = read('../useCodex.ts')
    expect(codex).toContain('confirmShell: settings.codexConfirmShell')
    expect(codex).toContain('cloudConfirmShell: settings.codexCloudConfirmShell')
  })

  it('the settings toggle is always visible now, since it governs Agent too', () => {
    const page = read('../../components/settings/SettingsPage.tsx')
    expect(page).toContain('Also confirm when Agent or Coding runs on an LU Cloud model')
    expect(page).not.toContain('{!settings.codexConfirmShell && (')
  })
})
