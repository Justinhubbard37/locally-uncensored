/**
 * C1 BINDUNG: the presets sit OVER the existing knobs and never write them.
 *
 * There is no render harness for these hooks in this repo, so the binding
 * properties are guarded at the source the same way decay-wiring.test.ts guards
 * the request builder. Each of these is something a well-meaning refactor would
 * undo silently, and each has a price:
 *
 *   - resolving the mode outside sendInstruction breaks "applies from the next
 *     send" outright,
 *   - a preset that writes settings.codexConfirmShell reaches the Agent surface
 *     immediately, because codexShellGate is consumed by BOTH loops since G15a,
 *   - a switch point still reading the raw setting means the preset is
 *     decorative on exactly that switch.
 *
 * The live half (settings really are untouched by a pick) is the runtime block
 * at the bottom, against the real settings store.
 *
 * Run: npx vitest run src/hooks/__tests__/codex-mode-wiring.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const backing = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = globalThis
globalThis.localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() { return backing.size },
} as Storage

const read = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8')
const codex = read('useCodex.ts')
const agent = read('useAgentChat.ts')

const { useCodexStore } = await import('../../stores/codexStore')
const { useSettingsStore } = await import('../../stores/settingsStore')

describe('the mode is resolved per send, from the conversation', () => {
  it('applies a parked pick at the start of the send', () => {
    expect(codex).toMatch(/applyParkedMode\(convId\)/)
  })

  it('resolves the mode against settings.codexDefaultMode, per send', () => {
    expect(codex).toMatch(/codexModeFor\(convId, settings\.codexDefaultMode\)/)
  })

  it('derives the effective knobs from the mode plus the settings', () => {
    expect(codex).toMatch(/const knobs = codexModeKnobs\(\{/)
    expect(codex).toMatch(/mode: codexMode,/)
  })
})

describe('the three switch points read the preset, not the raw setting', () => {
  it('the exec confirm gate is knobs.confirmExec', () => {
    expect(codex).toMatch(/awaitApproval: knobs\.confirmExec/)
    // Negative control: the pre-C1 shape called the gate inline with the
    // setting, which no preset could reach.
    expect(codex).not.toMatch(/awaitApproval: codexConfirmEnabled\(\{/)
  })

  it('Stage-and-Approve is knobs.stageWrites', () => {
    expect(codex).toMatch(/if \(knobs\.stageWrites\) \{/)
    expect(codex).not.toMatch(/if \(settings\.codexStageMode\) \{/)
  })

  it('the read-only chain is one flag, and all three gates use it', () => {
    expect(codex).toMatch(/const effectiveReadOnly = settings\.codexReviewMode === true \|\| readOnlyTurn \|\| codexMode === 'plan'/)
    // catalog strip (native), catalog strip (hermes), runtime mutation filter
    expect(codex.match(/effectiveReadOnly/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
    // Negative control: the old pair that hung on the slash flag alone.
    expect(codex).not.toMatch(/settings\.codexReviewMode \|\| readOnlyTurn/)
  })

  it('the run carries the read-only flag, so the executor gates check THIS run', () => {
    expect(codex).toMatch(/readOnlyShellTurn: effectiveReadOnly/)
    expect(codex).not.toMatch(/setReadOnlyShellTurn\(/)
  })
})

describe('a preset never writes the global settings', () => {
  it('useCodex does not call updateSettings at all', () => {
    expect(codex).not.toMatch(/updateSettings\(/)
  })

  it('the store action that the dropdown calls is per conversation', () => {
    // chooseCodexMode takes a conversation id; there is no global setter.
    const store = readFileSync(resolve(__dirname, '../../stores/codexStore.ts'), 'utf8')
    expect(store).toMatch(/chooseCodexMode: \(conversationId, mode, runActive\)/)
    expect(store).not.toMatch(/updateSettings/)
  })
})

describe('the Agent surface is untouched by the Code tab mode', () => {
  it('its cloud shell gate inputs are settings-only, byte for byte', () => {
    expect(agent).toContain(
      'codexConfirmEnabled({\n'
      + '              confirmShell: false,\n'
      + '              cloudConfirmShell: settings.codexCloudConfirmShell,\n'
      + '              providerId,\n'
      + '            })',
    )
  })

  it('never imports the mode model', () => {
    expect(agent).not.toMatch(/codex-mode/)
    expect(agent).not.toMatch(/codexModeKnobs|codexModeFor|CodexMode\b/)
  })

  it('opens its run with mode null, so no preset can be inferred from it', () => {
    expect(agent).toMatch(/mode: null,/)
  })
})

describe('cleanup is owned by the run, not by whoever finishes last', () => {
  it.each([['useCodex', codex], ['useAgentChat', agent]])('%s closes its own run', (_n, source) => {
    expect(source).toMatch(/endAgentRun\(run\)/)
    // Negative control: the blind reset that nulled a concurrent run's context.
    expect(source).not.toMatch(/clearActiveChatId\(\)/)
  })
})

describe('runtime: a pick in one conversation leaves everything else alone', () => {
  beforeEach(() => {
    localStorage.clear()
    useCodexStore.setState({
      modeByConversation: {},
      parkedModeByConversation: {},
      prePlanModeByConversation: {},
      planApprovalByConversation: {},
    })
  })

  it('Bypass in X does not move the settings by a single byte', () => {
    const before = JSON.stringify(useSettingsStore.getState().settings)
    useCodexStore.getState().chooseCodexMode('X', 'bypass', false)
    expect(JSON.stringify(useSettingsStore.getState().settings)).toBe(before)
  })

  it('Bypass in X leaves the Agent surface inputs identical', () => {
    const inputs = () => {
      const s = useSettingsStore.getState().settings
      return JSON.stringify({
        confirmShell: false,
        cloudConfirmShell: s.codexCloudConfirmShell,
      })
    }
    const before = inputs()
    useCodexStore.getState().chooseCodexMode('X', 'bypass', false)
    expect(inputs()).toBe(before)
  })

  it('Bypass in X leaves conversation Y on the default, which still asks', () => {
    useCodexStore.getState().chooseCodexMode('X', 'bypass', false)
    const defaultMode = useSettingsStore.getState().settings.codexDefaultMode
    expect(defaultMode).toBe('ask')
    expect(useCodexStore.getState().codexModeFor('Y', defaultMode)).toBe('ask')
  })

  it('negative control: the preset-as-settings-write shape trips both assertions', () => {
    const before = JSON.stringify(useSettingsStore.getState().settings)
    // Exactly what C1 BINDUNG forbids: pushing the preset into the settings.
    // Ask is the visible case (confirm on, stage on), and it would follow the
    // user into every other conversation.
    useSettingsStore.getState().updateSettings({ codexConfirmShell: true, codexStageMode: true })
    expect(JSON.stringify(useSettingsStore.getState().settings)).not.toBe(before)
    // ... and it would have reached the Agent surface through the same object.
    useSettingsStore.getState().updateSettings({ codexCloudConfirmShell: false })
    expect(useSettingsStore.getState().settings.codexCloudConfirmShell).toBe(false)
  })
})
