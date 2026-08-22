import { describe, it, expect } from 'vitest'
import { CODEX_CONFIRM_TOOLS, codexNeedsConfirm, codexConfirmEnabled } from '../codexShellGate'
import { DEFAULT_SETTINGS } from '../../lib/constants'

// H2: the coding-agent shell/code confirm gate. These tests lock the contract
// that (a) the autonomous workflow is unchanged when the gate is off, (b) the
// gate covers exactly the arbitrary-exec tools, and (c) file_write — which is
// path-jailed + stageable — is never caught by it.

describe('codexShellGate (H2)', () => {
  describe('CODEX_CONFIRM_TOOLS membership', () => {
    it('includes the arbitrary-exec tools', () => {
      expect(CODEX_CONFIRM_TOOLS.has('shell_execute')).toBe(true)
      expect(CODEX_CONFIRM_TOOLS.has('code_execute')).toBe(true)
      expect(CODEX_CONFIRM_TOOLS.has('shell_execute_background')).toBe(true)
    })

    it('does NOT include file_write (path-jailed + Stage mode handles it)', () => {
      expect(CODEX_CONFIRM_TOOLS.has('file_write')).toBe(false)
    })

    it('does NOT include read-only tools', () => {
      for (const t of ['file_read', 'file_list', 'file_search', 'git_status', 'web_search']) {
        expect(CODEX_CONFIRM_TOOLS.has(t)).toBe(false)
      }
    })
  })

  describe('codexNeedsConfirm', () => {
    it('off by default: never confirms even for shell_execute (autonomous workflow preserved)', () => {
      expect(codexNeedsConfirm('shell_execute', false)).toBe(false)
      expect(codexNeedsConfirm('code_execute', false)).toBe(false)
    })

    it('on: confirms the arbitrary-exec tools', () => {
      expect(codexNeedsConfirm('shell_execute', true)).toBe(true)
      expect(codexNeedsConfirm('code_execute', true)).toBe(true)
      expect(codexNeedsConfirm('shell_execute_background', true)).toBe(true)
    })

    it('on: does NOT confirm file_write or read-only tools', () => {
      expect(codexNeedsConfirm('file_write', true)).toBe(false)
      expect(codexNeedsConfirm('file_read', true)).toBe(false)
      expect(codexNeedsConfirm('web_search', true)).toBe(false)
    })
  })

  // History: the 2.5.7 review hard-wired providerId === 'lu-cloud' into the
  // gate, so the confirm toggle silently did nothing on a cloud model (David
  // 2026-07-24, "auto approve bei cloud modellen setting nicht funktional").
  // 2.5.9 made it a visible setting that still defaulted ON, and G15a
  // (2026-08-07) carried the same default to the Agent surface.
  //
  // David 2026-08-22 replaces that decision: bypass means bypass, on a cloud
  // model too, and the customer who picks it makes the call. The cloud arm is
  // an opt-in now and ships OFF. These lock both halves.
  describe('codexConfirmEnabled (cloud arm, opt-in since 2026-08-22)', () => {
    const LOCALS = ['ollama', 'openai', 'anthropic']

    it('THE DECISION: the shipped default leaves a cloud model unattended', () => {
      expect(DEFAULT_SETTINGS.codexCloudConfirmOptIn).toBe(false)
      expect(
        codexConfirmEnabled({
          confirmShell: false,
          cloudOptIn: DEFAULT_SETTINGS.codexCloudConfirmOptIn,
          providerId: 'lu-cloud',
        })
      ).toBe(false)
    })

    it('a cloud model with the opt-in off behaves exactly like a local one', () => {
      for (const providerId of [...LOCALS, 'lu-cloud']) {
        expect(codexConfirmEnabled({ confirmShell: false, cloudOptIn: false, providerId })).toBe(false)
      }
    })

    it('the opt-in is what brings the cloud confirm back', () => {
      expect(codexConfirmEnabled({ confirmShell: false, cloudOptIn: true, providerId: 'lu-cloud' })).toBe(true)
    })

    it('global toggle on: confirms on every provider, cloud arm irrelevant', () => {
      for (const providerId of [...LOCALS, 'lu-cloud']) {
        expect(codexConfirmEnabled({ confirmShell: true, cloudOptIn: false, providerId })).toBe(true)
        expect(codexConfirmEnabled({ confirmShell: true, cloudOptIn: true, providerId })).toBe(true)
      }
    })

    it('the cloud arm never gates a local provider, opted in or not', () => {
      for (const providerId of LOCALS) {
        expect(codexConfirmEnabled({ confirmShell: false, cloudOptIn: true, providerId })).toBe(false)
        expect(codexConfirmEnabled({ confirmShell: false, cloudOptIn: false, providerId })).toBe(false)
      }
    })
  })
})
