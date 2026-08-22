/**
 * Ask / Bypass / Plan as a preset over the existing knobs (plan 2.6.6, C1).
 *
 * Every claim here has a negative control right next to it, because the whole
 * point of the feature is what it REFUSES: if a test only proves plan mode
 * denies file_write, it has not proved the denial comes from plan mode.
 *
 * Run: npx vitest run src/lib/__tests__/codex-mode.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  codexModeKnobs, codexModeRuleset, decideForTool, resolveCodexMode,
  resolveApproveTargetMode, isCodexMode, CODEX_MODES, CODEX_MODE_LABELS,
  type CodexMode,
} from '../codex-mode'
import { MUTATING_TOOLS } from '../mutating-tools'

const SETTINGS = {
  codexConfirmShell: false,
  codexCloudConfirmOptIn: false,
  codexStageMode: false,
  codexReviewMode: false,
}

const knobs = (mode: CodexMode, over: Partial<typeof SETTINGS> = {}, providerId = 'ollama', readOnlyTurn = false) =>
  codexModeKnobs({ mode, settings: { ...SETTINGS, ...over }, providerId, readOnlyTurn })

describe('the dropdown labels are the ones the plan pins', () => {
  it('reads Ask permissions / Bypass permissions / Plan mode', () => {
    expect(CODEX_MODE_LABELS.ask).toBe('Ask permissions')
    expect(CODEX_MODE_LABELS.bypass).toBe('Bypass permissions')
    expect(CODEX_MODE_LABELS.plan).toBe('Plan mode')
    expect(CODEX_MODES).toEqual(['ask', 'bypass', 'plan'])
  })
})

describe('mode resolution: conversation first, then the global default', () => {
  it('takes the conversation mode when it has one', () => {
    expect(resolveCodexMode('bypass', 'ask')).toBe('bypass')
  })
  it('falls back to the global default when it has none', () => {
    expect(resolveCodexMode(undefined, 'plan')).toBe('plan')
  })
  it('falls back to ask when neither is a mode', () => {
    expect(resolveCodexMode(undefined, undefined)).toBe('ask')
    // Negative control: junk from a downgraded persist file is not a mode.
    expect(resolveCodexMode('yolo', 'nonsense')).toBe('ask')
    expect(isCodexMode('yolo')).toBe(false)
  })
})

describe('switch point 1: the exec confirm gate', () => {
  it('Ask forces it on, whatever the setting says', () => {
    expect(knobs('ask').confirmExec).toBe(true)
    expect(knobs('ask', { codexConfirmShell: false }).confirmExec).toBe(true)
  })
  it('Bypass turns the LOCAL arm off', () => {
    expect(knobs('bypass', { codexConfirmShell: true }).confirmExec).toBe(false)
  })
  it('negative control: the same settings under Ask still confirm', () => {
    expect(knobs('ask', { codexConfirmShell: true }).confirmExec).toBe(true)
  })
})

describe('switch point 2: Stage-and-Approve for file_write / file_edit', () => {
  it('Ask stages even when the setting is off', () => {
    expect(knobs('ask', { codexStageMode: false }).stageWrites).toBe(true)
  })
  it('Bypass does not stage even when the setting is on', () => {
    expect(knobs('bypass', { codexStageMode: true }).stageWrites).toBe(false)
  })
  it('Plan does not stage, it has no writes to stage', () => {
    expect(knobs('plan', { codexStageMode: true }).stageWrites).toBe(false)
  })
})

describe('switch point 3: the read-only chain', () => {
  it('Plan arms it and swaps in the plan prompt', () => {
    expect(knobs('plan').readOnly).toBe(true)
    expect(knobs('plan').planPrompt).toBe(true)
  })
  it('negative control: Ask and Bypass leave it disarmed', () => {
    expect(knobs('ask').readOnly).toBe(false)
    expect(knobs('bypass').readOnly).toBe(false)
    expect(knobs('ask').planPrompt).toBe(false)
    expect(knobs('bypass').planPrompt).toBe(false)
  })
  it('the more restrictive of mode and Code-Review Mode wins', () => {
    expect(knobs('bypass', { codexReviewMode: true }).readOnly).toBe(true)
    expect(knobs('ask', { codexReviewMode: true }).readOnly).toBe(true)
  })
  it('a read-only slash command arms it in every mode', () => {
    for (const mode of CODEX_MODES) {
      expect(knobs(mode, {}, 'ollama', true).readOnly).toBe(true)
    }
  })
  it('the plan prompt is never used outside Plan mode, even on a read-only turn', () => {
    expect(knobs('ask', {}, 'ollama', true).planPrompt).toBe(false)
    expect(knobs('bypass', { codexReviewMode: true }).planPrompt).toBe(false)
  })
})

// David 2026-08-22, replacing G15a: the cloud arm is the user's opt-in, not a
// fourth mode. Off by default, so lu-cloud goes through the same three modes a
// local provider does.
describe('the cloud shell gate is an opt-in, not a fourth mode', () => {
  it('THE DECISION: Bypass on a cloud model runs unattended, like Bypass on a local one', () => {
    expect(knobs('bypass', { codexConfirmShell: false }, 'lu-cloud').confirmExec).toBe(false)
    expect(knobs('bypass', { codexConfirmShell: true }, 'lu-cloud').confirmExec).toBe(false)
  })
  it.each(CODEX_MODES)('%s treats lu-cloud exactly like ollama while the opt-in is off', (mode) => {
    expect(knobs(mode, { codexConfirmShell: false }, 'lu-cloud').confirmExec)
      .toBe(knobs(mode, { codexConfirmShell: false }, 'ollama').confirmExec)
  })
  it('negative control: Ask still asks on a cloud model, because Ask means ask', () => {
    expect(knobs('ask', { codexConfirmShell: false }, 'lu-cloud').confirmExec).toBe(true)
  })
  it.each(CODEX_MODES)('%s confirms on lu-cloud once the user opts in, Bypass included', (mode) => {
    expect(knobs(mode, { codexConfirmShell: false, codexCloudConfirmOptIn: true }, 'lu-cloud').confirmExec).toBe(true)
  })
  it('negative control: opting in never gates a local provider', () => {
    expect(knobs('bypass', { codexConfirmShell: false, codexCloudConfirmOptIn: true }, 'ollama').confirmExec).toBe(false)
    expect(knobs('plan', { codexConfirmShell: false, codexCloudConfirmOptIn: true }, 'ollama').confirmExec).toBe(false)
  })
  it('an undefined value from an older profile counts as not opted in', () => {
    expect(codexModeKnobs({ mode: 'bypass', settings: {}, providerId: 'lu-cloud' }).confirmExec).toBe(false)
  })
})

describe('the preset never writes anything', () => {
  it('leaves the settings object it was handed byte-identical', () => {
    const settings = { ...SETTINGS, codexConfirmShell: true, codexStageMode: true }
    const before = JSON.stringify(settings)
    for (const mode of CODEX_MODES) {
      codexModeKnobs({ mode, settings, providerId: 'lu-cloud', readOnlyTurn: false })
    }
    expect(JSON.stringify(settings)).toBe(before)
  })
  it('negative control: a preset that DID write would be visible here', () => {
    const settings = { ...SETTINGS }
    const before = JSON.stringify(settings)
    // This is the shape the plan forbids: the preset pushed into the settings.
    ;(settings as { codexConfirmShell: boolean }).codexConfirmShell = false
    ;(settings as { codexStageMode: boolean }).codexStageMode = true
    expect(JSON.stringify(settings)).not.toBe(before)
  })
})

describe('the ruleset behind the presets', () => {
  const mutatingExceptShell = [...MUTATING_TOOLS].filter((n) => n !== 'shell_execute')

  it('Plan denies every mutating tool by name', () => {
    const rules = codexModeRuleset('plan')
    for (const name of mutatingExceptShell) {
      expect(decideForTool(rules, name)).toBe('deny')
    }
  })
  it('Plan keeps shell_execute allowed by NAME, its gate is the command classifier', () => {
    expect(decideForTool(codexModeRuleset('plan'), 'shell_execute')).toBe('allow')
  })
  it('Plan still allows the readers', () => {
    for (const name of ['file_read', 'file_list', 'file_search', 'todo_write']) {
      expect(decideForTool(codexModeRuleset('plan'), name)).toBe('allow')
    }
  })
  it('negative control: Bypass allows exactly what Plan denies', () => {
    const rules = codexModeRuleset('bypass')
    for (const name of mutatingExceptShell) {
      expect(decideForTool(rules, name)).toBe('allow')
    }
  })
  it('Ask asks for the exec tools and the writes, and allows the rest', () => {
    const rules = codexModeRuleset('ask')
    for (const name of ['shell_execute', 'code_execute', 'shell_execute_background', 'file_write', 'file_edit']) {
      expect(decideForTool(rules, name)).toBe('ask')
    }
    expect(decideForTool(rules, 'file_read')).toBe('allow')
  })
  it('a trailing star matches by prefix, so bash-style globs can follow later', () => {
    expect(decideForTool([{ pattern: 'git_*', decision: 'deny' }], 'git_push')).toBe('deny')
    expect(decideForTool([{ pattern: 'git_*', decision: 'deny' }], 'file_read')).toBe('allow')
  })
})

describe('Approve and run never lands in Bypass by itself (blocker S7)', () => {
  it('a mode parked during the plan run wins', () => {
    expect(resolveApproveTargetMode({ parked: 'bypass', previous: 'ask' })).toBe('bypass')
    expect(resolveApproveTargetMode({ parked: 'ask', previous: 'ask' })).toBe('ask')
  })
  it('without a parked pick, a Bypass from before the plan becomes Ask', () => {
    expect(resolveApproveTargetMode({ previous: 'bypass' })).toBe('ask')
  })
  it('negative control: inheriting the previous mode verbatim would have said bypass', () => {
    const naive = (previous: CodexMode) => previous
    expect(naive('bypass')).toBe('bypass')
    expect(resolveApproveTargetMode({ previous: 'bypass' })).not.toBe(naive('bypass'))
  })
  it('a conversation that STARTED in plan mode gets Ask, never the global default', () => {
    expect(resolveApproveTargetMode({})).toBe('ask')
    // Even when that default is Bypass: the resolver is not given it at all.
    expect(resolveApproveTargetMode({ previous: undefined, parked: undefined })).toBe('ask')
  })
  it('an Ask from before the plan is kept', () => {
    expect(resolveApproveTargetMode({ previous: 'ask' })).toBe('ask')
  })
  it('parking Plan again is not a pick, it falls through to the rules', () => {
    expect(resolveApproveTargetMode({ parked: 'plan', previous: 'bypass' })).toBe('ask')
  })
})
