/**
 * One cloud shell policy for both surfaces (G15a, 2026-08-07): the Code tab
 * and Agent mode read the SAME helper and the SAME setting, because R23 found
 * Agent running the exec tools on a cloud model unattended while the Code tab
 * confirmed them.
 *
 * David 2026-08-22 replaces the policy that shared setting carried: bypass
 * means bypass on a cloud model too, so the setting is an opt-in and ships
 * OFF. With it off, a cloud model is gated by the per-tool permission level
 * and by nothing else. With it on, the confirm rides ON TOP of that level, in
 * Bypass as well, which is the whole point of opting in.
 *
 * Run: npx vitest run src/hooks/__tests__/agent-shell-gate.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { CODEX_CONFIRM_TOOLS, codexConfirmEnabled } from '../codexShellGate'
import { DEFAULT_SETTINGS } from '../../lib/constants'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')
const agent = read('../useAgentChat.ts')

// The two lines useAgentChat runs per tool call, kept in the same shape as the
// source (pinned below, so this stops being a paraphrase the moment it drifts).
const cloudArm = (toolName: string, providerId: string, cloudOptIn: boolean) =>
  CODEX_CONFIRM_TOOLS.has(toolName) && codexConfirmEnabled({ confirmShell: false, cloudOptIn, providerId })
const needsApproval = (permLevel: string, toolName: string, providerId: string, cloudOptIn: boolean) =>
  permLevel !== 'auto' || cloudArm(toolName, providerId, cloudOptIn)

const OPT_IN_DEFAULT = DEFAULT_SETTINGS.codexCloudConfirmOptIn

describe('the shipped default: a cloud model is not special', () => {
  it('ships with the cloud opt-in off', () => {
    expect(OPT_IN_DEFAULT).toBe(false)
  })

  it('THE DECISION: permission level auto runs shell on a cloud model unattended', () => {
    expect(needsApproval('auto', 'shell_execute', 'lu-cloud', OPT_IN_DEFAULT)).toBe(false)
    expect(needsApproval('auto', 'code_execute', 'lu-cloud', OPT_IN_DEFAULT)).toBe(false)
    expect(needsApproval('auto', 'shell_execute_background', 'lu-cloud', OPT_IN_DEFAULT)).toBe(false)
  })

  it('a cloud model and a local model are gated identically', () => {
    for (const providerId of ['lu-cloud', 'ollama', 'openai']) {
      expect(needsApproval('auto', 'shell_execute', providerId, OPT_IN_DEFAULT)).toBe(false)
    }
  })

  it('NEGATIVE CONTROL: the permission level itself still gates, it was never loosened', () => {
    expect(needsApproval('ask', 'shell_execute', 'lu-cloud', OPT_IN_DEFAULT)).toBe(true)
    expect(needsApproval('ask', 'shell_execute', 'ollama', OPT_IN_DEFAULT)).toBe(true)
  })
})

describe('the opt-in, for the user who wants the cloud confirm back', () => {
  it('an opted-in user is asked again on a cloud model, even at level auto', () => {
    expect(needsApproval('auto', 'shell_execute', 'lu-cloud', true)).toBe(true)
  })

  it('opting in does not touch local providers', () => {
    expect(needsApproval('auto', 'shell_execute', 'ollama', true)).toBe(false)
    expect(needsApproval('auto', 'shell_execute', 'openai', true)).toBe(false)
  })

  it('only the arbitrary-exec tools are gated, never the jailed file tools', () => {
    expect(cloudArm('shell_execute', 'lu-cloud', true)).toBe(true)
    expect(cloudArm('code_execute', 'lu-cloud', true)).toBe(true)
    expect(cloudArm('shell_execute_background', 'lu-cloud', true)).toBe(true)
    expect(cloudArm('file_write', 'lu-cloud', true)).toBe(false)
    expect(cloudArm('web_fetch', 'lu-cloud', true)).toBe(false)
  })
})

describe('wiring in useAgentChat', () => {
  it('the cloud arm rides ON TOP of the permission level, never replaces it', () => {
    expect(agent).toContain("const needsApproval = permLevel !== 'auto' || cloudShellConfirm")
  })

  it('the gate reads the SAME shared helper and setting as the Code tab', () => {
    expect(agent).toContain("import { CODEX_CONFIRM_TOOLS, codexConfirmEnabled } from './codexShellGate'")
    expect(agent).toContain('cloudOptIn: settings.codexCloudConfirmOptIn')
    expect(agent).toContain('CODEX_CONFIRM_TOOLS.has(tc.function.name)')
    // Negative control: the retired key must be gone from this surface, or a
    // profile that still has it on disk would quietly keep the old policy.
    expect(agent).not.toContain('codexCloudConfirmShell')
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

  it('the Codex side feeds the same two settings into the same helper', () => {
    const codex = read('../useCodex.ts')
    // Since 2.6.6 C1 the Code tab reaches the gate through the mode preset
    // instead of calling it inline. Same inputs, same helper, same opt-in.
    expect(codex).toContain('codexModeKnobs({')
    expect(codex).toContain('codexConfirmShell: settings.codexConfirmShell')
    expect(codex).toContain('codexCloudConfirmOptIn: settings.codexCloudConfirmOptIn')
    expect(codex).not.toContain('codexCloudConfirmShell')
  })

  it('the settings toggle stays visible, and reads as the opt-in it now is', () => {
    const page = read('../../components/settings/SettingsPage.tsx')
    expect(page).toContain('when Agent or Coding runs on an LU Cloud model')
    expect(page).toContain('off by default')
    expect(page).toContain('settings.codexCloudConfirmOptIn')
    expect(page).not.toContain('{!settings.codexConfirmShell && (')
  })

  it('the mode dropdown no longer carries the cloud exception, there is none', () => {
    const dropdown = read('../../components/chat/CodexModeDropdown.tsx')
    expect(dropdown).not.toContain('Bypass never lifts')
    expect(dropdown).not.toMatch(/cloud shell confirm/i)
  })
})
