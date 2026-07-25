import { describe, it, expect } from 'vitest'
import {
  AGENT_COMMANDS,
  getAgentCommand,
  parseAgentCommand,
  matchAgentCommands,
} from '../agent-commands'
import { MUTATING_TOOLS } from '../mutating-tools'

// The 2.5.9 set. Kept as an explicit list rather than a count so a rename or an
// accidental drop fails loudly instead of quietly changing a number.
const EXPECTED = [
  // steer
  'goal', 'loop',
  // understand
  'plan', 'explain', 'find', 'diff', 'log', 'todo',
  // change
  'fix', 'types', 'test', 'refactor', 'clean', 'optimize',
  // check
  'review', 'security', 'deps',
  // ship
  'commit', 'pr', 'undo', 'docs', 'init',
]

describe('AGENT_COMMANDS registry', () => {
  it('ships the expected command set', () => {
    expect(AGENT_COMMANDS.map((c) => c.name).sort()).toEqual([...EXPECTED].sort())
  })

  it('every command has a summary and a non-empty expansion', () => {
    for (const c of AGENT_COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(5)
      // A locally-handled command's build() is a short marker the hook reads,
      // not a prompt, so it is exempt from the length floor.
      const floor = c.handledLocally ? 4 : 40
      expect(c.build('').length, c.name).toBeGreaterThan(floor)
      expect(c.build('src/app.ts').length, c.name).toBeGreaterThan(floor)
    }
  })

  it('command names are unique', () => {
    const names = AGENT_COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every command that reaches a model tells it to act via tools', () => {
    for (const c of AGENT_COMMANDS) {
      if (c.handledLocally) continue
      expect(c.build(''), c.name).toContain('Use your tools')
    }
  })

  it('marks only /goal as handled locally', () => {
    // Everything else must reach a model; a second locally-handled command
    // would need its own branch in three hooks and would silently no-op if it
    // did not get one.
    expect(AGENT_COMMANDS.filter((c) => c.handledLocally).map((c) => c.name)).toEqual(['goal'])
  })

  it('/loop refuses to fake a green result', () => {
    const t = getAgentCommand('loop')!.build('make the tests pass')
    expect(t).toContain('Never loosen the check to make it pass')
    expect(t).toContain('never delete or skip a test to go green')
    // And it has to stop rather than spin: a loop with no exit burns a cloud
    // budget until the iteration cap saves it.
    expect(t).toContain('Stop EARLY')
  })

  it('an argument the user typed always reaches the expansion', () => {
    // A template that silently drops its args looks like it worked and does the
    // wrong thing, which is worse than refusing.
    const arg = 'src/hooks/useChat.ts'
    for (const c of AGENT_COMMANDS) {
      // /init takes no argument by design.
      if (c.name === 'init') continue
      expect(c.build(arg), `${c.name} dropped its argument`).toContain(arg)
    }
  })

  it('read-only commands never name a mutating tool in their template', () => {
    // The runner strips these tools for the turn, so a template that asks for
    // one would be instructing the model to reach for something that is gone.
    for (const c of AGENT_COMMANDS.filter((c) => c.readOnly)) {
      const text = c.build('x')
      for (const tool of MUTATING_TOOLS) {
        expect(text, `${c.name} names ${tool}`).not.toContain(tool)
      }
    }
  })

  it('read-only commands say up front that they cannot write or run', () => {
    for (const c of AGENT_COMMANDS.filter((c) => c.readOnly)) {
      expect(c.build('x')).toContain('no write or shell tools')
    }
  })

  it('marks exactly the inspection commands read-only', () => {
    expect(AGENT_COMMANDS.filter((c) => c.readOnly).map((c) => c.name).sort()).toEqual(
      ['diff', 'explain', 'find', 'plan', 'review', 'security', 'todo'].sort(),
    )
  })

  it('getAgentCommand looks up by name, case-insensitively', () => {
    expect(getAgentCommand('review')?.name).toBe('review')
    expect(getAgentCommand('REVIEW')?.name).toBe('review')
    expect(getAgentCommand('nope')).toBeUndefined()
  })
})

describe('parseAgentCommand', () => {
  it('parses a bare command', () => {
    const r = parseAgentCommand('/init')
    expect(r?.command.name).toBe('init')
    expect(r?.args).toBe('')
    expect(r?.expanded).toContain('AGENTS.md')
  })

  it('parses a command with args and threads them into the expansion', () => {
    const r = parseAgentCommand('/explain src/hooks/useChat.ts')
    expect(r?.command.name).toBe('explain')
    expect(r?.args).toBe('src/hooks/useChat.ts')
    expect(r?.expanded).toContain('src/hooks/useChat.ts')
  })

  it('is case-insensitive on the command name', () => {
    expect(parseAgentCommand('/REVIEW changes')?.command.name).toBe('review')
  })

  it('handles multi-line / quoted args', () => {
    const r = parseAgentCommand('/fix TypeError: cannot read "x" of undefined\nat foo.ts:10')
    expect(r?.command.name).toBe('fix')
    expect(r?.expanded).toContain('TypeError')
  })

  it('tolerates leading whitespace', () => {
    expect(parseAgentCommand('  /review')?.command.name).toBe('review')
  })

  it('returns null for unknown commands so they fall through to chat', () => {
    expect(parseAgentCommand('/notacommand do thing')).toBeNull()
    expect(parseAgentCommand('/')).toBeNull()
  })

  it('returns null for normal text and for a slash mid-sentence', () => {
    expect(parseAgentCommand('hello there')).toBeNull()
    expect(parseAgentCommand('what is 1/2 of 8')).toBeNull()
    expect(parseAgentCommand('please run the /review later')).toBeNull()
  })

  it('commit template forbids pushing', () => {
    expect(parseAgentCommand('/commit')?.expanded.toLowerCase()).toContain('do not push')
  })

  it('undo shows what would be lost before destroying it', () => {
    const t = parseAgentCommand('/undo')!.expanded
    expect(t).toContain('show the user exactly what would be lost')
    expect(t.toLowerCase()).toContain('never rewrite published history')
  })

  it('pr does not silently sweep in uncommitted work', () => {
    expect(parseAgentCommand('/pr')?.expanded).toContain('ask before including them')
  })

  it('deps reports without upgrading', () => {
    expect(parseAgentCommand('/deps')?.expanded).toContain('Do NOT upgrade anything yet')
  })

  it('types refuses to silence errors quietly', () => {
    const t = parseAgentCommand('/types')!.expanded
    expect(t).toContain('never silence one with')
  })

  it('clean proves a symbol is unused before deleting it', () => {
    expect(parseAgentCommand('/clean')?.expanded).toContain('Prove each one is unused')
  })

  it('plan stops at the plan', () => {
    expect(parseAgentCommand('/plan add caching')?.expanded).toContain('Do not start implementing')
  })
})

describe('matchAgentCommands (autocomplete)', () => {
  it('returns every command for a lone slash', () => {
    expect(matchAgentCommands('/').length).toBe(AGENT_COMMANDS.length)
  })

  it('prefix-filters by name', () => {
    expect(matchAgentCommands('/re').map((c) => c.name).sort()).toEqual(['refactor', 'review'])
    expect(matchAgentCommands('/sec').map((c) => c.name)).toEqual(['security'])
    expect(matchAgentCommands('/d').map((c) => c.name).sort()).toEqual(['deps', 'diff', 'docs'])
  })

  it('opens the menu even when the line starts with whitespace', () => {
    // parseAgentCommand trimmed and matchAgentCommands did not, so hitting
    // space first killed the menu while sending still expanded the command.
    expect(matchAgentCommands('  /re').map((c) => c.name).sort()).toEqual(['refactor', 'review'])
  })

  it('closes once the user has typed a space (now typing args, not picking)', () => {
    expect(matchAgentCommands('/review ')).toEqual([])
    expect(matchAgentCommands('/review changes')).toEqual([])
  })

  it('returns [] for a non-slash input', () => {
    expect(matchAgentCommands('review')).toEqual([])
    expect(matchAgentCommands('')).toEqual([])
  })

  it('returns [] for an unmatched prefix', () => {
    expect(matchAgentCommands('/zzz')).toEqual([])
  })
})
