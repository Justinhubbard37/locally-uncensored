import { describe, it, expect } from 'vitest'
import { CODEX_CONFIRM_TOOLS, codexNeedsConfirm, codexConfirmEnabled } from '../codexShellGate'

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

  // 2.5.9 — David 2026-07-24: "auto approve bei cloud modellen setting nicht
  // funktional". The 2.5.7 review hard-wired providerId === 'lu-cloud' into the
  // gate, so the confirm toggle silently did nothing on a cloud model. These
  // lock the new contract: same safe default, but the user can now actually
  // turn the cloud arm off.
  describe('codexConfirmEnabled (cloud arm)', () => {
    const LOCALS = ['ollama', 'openai', 'anthropic']

    it('both off on a local model: unattended, the autonomous default', () => {
      for (const providerId of LOCALS) {
        expect(codexConfirmEnabled({ confirmShell: false, cloudConfirmShell: true, providerId })).toBe(false)
      }
    })

    it('global toggle on: confirms on every provider, cloud arm irrelevant', () => {
      for (const providerId of [...LOCALS, 'lu-cloud']) {
        expect(codexConfirmEnabled({ confirmShell: true, cloudConfirmShell: false, providerId })).toBe(true)
        expect(codexConfirmEnabled({ confirmShell: true, cloudConfirmShell: true, providerId })).toBe(true)
      }
    })

    it('default (cloud arm on): a cloud model still confirms — 2.5.8 behaviour preserved', () => {
      expect(codexConfirmEnabled({ confirmShell: false, cloudConfirmShell: true, providerId: 'lu-cloud' })).toBe(true)
    })

    it('THE FIX: cloud arm off means auto-approve finally works on cloud models', () => {
      expect(codexConfirmEnabled({ confirmShell: false, cloudConfirmShell: false, providerId: 'lu-cloud' })).toBe(false)
    })

    it('the cloud arm never gates a local provider', () => {
      for (const providerId of LOCALS) {
        expect(codexConfirmEnabled({ confirmShell: false, cloudConfirmShell: true, providerId })).toBe(false)
        expect(codexConfirmEnabled({ confirmShell: false, cloudConfirmShell: false, providerId })).toBe(false)
      }
    })
  })
})
