/**
 * A blocked category must not reach the model in the Code tab.
 *
 * Found 2026-08-06 while mapping the Agent + Coding tool matrix (plan section
 * G). The Code tab picks its tool list three different ways and only two of
 * them honoured the permission map:
 *
 *   small-model mode  selectRelevantToolsAsync(..., permissions)  filters
 *   local model       selectRelevantTools(..., permissions)       filters
 *   REMOTE model      codexTools, handed to the request untouched  DID NOT
 *
 * The hermes path never had the hole, because it starts from
 * toolRegistry.toHermesToolDefs(permissions). So the same setting behaved
 * differently depending on which schema the model happened to speak, which is
 * exactly the drift the matrix is looking for.
 *
 * It mattered because this surface has no second gate: useCodex never
 * re-checks the permission at execution time (codexConfirmEnabled is a shell
 * confirm keyed on provider and settings, not on the permission map), and
 * toolRegistry.execute() runs whatever it is handed. The tool list WAS the
 * gate, so offering a blocked tool meant running it.
 *
 * Fix: build the list from getAvailableTools(permissions), so every branch
 * downstream inherits the filter.
 *
 * Run: npx vitest run src/hooks/__tests__/useCodex-tool-permissions.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { toolRegistry, DEFAULT_PERMISSIONS } from '../../api/mcp'
import type { PermissionMap } from '../../api/mcp/types'

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../useCodex.ts'),
  'utf8',
)

// Mirrors CODEX_CATEGORIES in useCodex.ts. Kept literal on purpose: the point
// is to catch the constant changing without this test moving with it.
const CODEX_CATEGORIES = ['filesystem', 'terminal', 'system', 'web', 'image', 'video', 'workflow']
const codexVisible = <T extends { category: string }>(tools: T[]): T[] =>
  tools.filter((t) => CODEX_CATEGORIES.includes(t.category))

describe('the Code tab honours a blocked category', () => {
  it('getAll ignores the permission map, which is why it must not be the source', () => {
    const blocked: PermissionMap = { ...DEFAULT_PERMISSIONS, terminal: 'blocked' }
    const all = toolRegistry.getAll()
    expect(all.some((t) => t.category === 'terminal')).toBe(true)
    expect(toolRegistry.getAvailableTools(blocked).some((t) => t.category === 'terminal')).toBe(false)
  })

  it('blocking terminal removes shell_execute from what the Code tab would send', () => {
    const blocked: PermissionMap = { ...DEFAULT_PERMISSIONS, terminal: 'blocked' }
    const sent = codexVisible(toolRegistry.getAvailableTools(blocked)).map((t) => t.name)
    expect(sent).not.toContain('shell_execute')
    expect(sent).not.toContain('git_push')
    // The rest of the toolbox survives, so this is a filter and not a wipe.
    expect(sent).toContain('file_read')
    expect(sent).toContain('web_search')
  })

  it('blocking a category the Code tab does not show changes nothing', () => {
    // screenshot is category 'desktop', which CODEX_CATEGORIES omits.
    const blocked: PermissionMap = { ...DEFAULT_PERMISSIONS, desktop: 'blocked' }
    const before = codexVisible(toolRegistry.getAvailableTools(DEFAULT_PERMISSIONS)).length
    const after = codexVisible(toolRegistry.getAvailableTools(blocked)).length
    expect(after).toBe(before)
  })

  it('the default permission map blocks nothing, so the default catalog is whole', () => {
    expect(toolRegistry.getAvailableTools(DEFAULT_PERMISSIONS)).toHaveLength(toolRegistry.getAll().length)
  })
})

describe('the fix sits at the source, not in one branch', () => {
  it('codexToolsAll is built from getAvailableTools(permissions)', () => {
    expect(src).toMatch(/const codexToolsAll = toolRegistry\.getAvailableTools\(permissions\)/)
  })

  it('the codex tool list never starts from getAll()', () => {
    // getAll() may still appear for diagnostics (allToolsCount) and for the
    // known-name check; what must not come back is getAll() feeding the list
    // that becomes the request.
    expect(src).not.toMatch(/const codexToolsAll = toolRegistry\.getAll\(\)/)
  })

  it('the remote branch still hands the list straight through, which is why the source must be clean', () => {
    // If this ever grows its own filter the comment above stops being true;
    // this pins the shape the fix depends on.
    expect(src).toMatch(/!isLocalModelByName\(activeModel\)\s*\n?\s*\?\s*codexTools/)
  })

  it('the hermes path keeps taking permissions', () => {
    expect(src).toMatch(/toolRegistry\.toHermesToolDefs\(permissions\)/)
  })
})

/**
 * The offer is not the gate on this surface, so the same rule needs a second
 * check right before the executor. The read-only version of this was found live
 * on 2026-07-25 (/plan was offered read tools only and still created a file):
 * the loose-parse fallback lifts a call the model wrote as TEXT and hands the
 * name to toolRegistry.execute, which resolves by name and asks nothing.
 * The permission map never got the same treatment until 2026-08-06.
 */
describe('a blocked tool is refused at execution, not only at offer time', () => {
  it('getPermissionLevel reports blocked, which is what the gate reads', () => {
    const blocked: PermissionMap = { ...DEFAULT_PERMISSIONS, terminal: 'blocked' }
    expect(toolRegistry.getPermissionLevel('shell_execute', blocked)).toBe('blocked')
    expect(toolRegistry.getPermissionLevel('file_read', blocked)).not.toBe('blocked')
  })

  it('an unknown name is not blocked, so it still reaches the executor and errors there', () => {
    // Otherwise a typo would be silently swallowed instead of producing the
    // "Unknown tool" the model needs in order to correct itself.
    const blocked: PermissionMap = { ...DEFAULT_PERMISSIONS, terminal: 'blocked' }
    expect(toolRegistry.getPermissionLevel('explain_phenomenon', blocked)).toBe('confirm')
  })

  it('useCodex filters the calls by permission before executing them', () => {
    expect(src).toMatch(/toolRegistry\.getPermissionLevel\(tc\.function\?\.name \?\? '', permissions\) === 'blocked'/)
    expect(src).toMatch(/switched off for this conversation in the tool permissions/)
  })
})

describe('the name repair runs before both gates', () => {
  // Both gates match on the tool NAME. Running them first let a decorated name
  // walk through: `file_write<|channel|>commentary` (seen live from gpt-oss on
  // 2026-07-24) is not in MUTATING_TOOLS and is not registered, so a read-only
  // turn passed it, and canonicalToolName then turned it into `file_write`
  // on the way to the executor.
  const repairAt = src.indexOf('const knownToolNames = toolRegistry.getAll()')
  const readOnlyGateAt = src.indexOf('const blocked = toolCalls.filter((tc) => MUTATING_TOOLS.has')
  const permissionGateAt = src.indexOf('const refused = toolCalls.filter(isBlocked)')

  it('all three landmarks are present', () => {
    expect(repairAt).toBeGreaterThan(-1)
    expect(readOnlyGateAt).toBeGreaterThan(-1)
    expect(permissionGateAt).toBeGreaterThan(-1)
  })

  it('repair comes before the read-only strip', () => {
    expect(repairAt).toBeLessThan(readOnlyGateAt)
  })

  it('repair comes before the permission strip', () => {
    expect(repairAt).toBeLessThan(permissionGateAt)
  })
})
