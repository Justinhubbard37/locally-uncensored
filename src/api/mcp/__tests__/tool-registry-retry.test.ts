/**
 * Audit B2 — a retry re-RUNS the tool, so it must never happen for a
 * side-effecting tool, and never for anything the user aborted. Before this
 * rule the throw path retried EVERYTHING once, blind: a git_commit whose
 * invoke threw after the commit landed committed twice, an aborted
 * shell_execute ran again into the abort.
 */
import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '../tool-registry'
import type { MCPToolDefinition } from '../types'

const mkTool = (name: string, category: MCPToolDefinition['category'] = 'terminal'): MCPToolDefinition => ({
  name,
  description: `description of ${name}`,
  inputSchema: { type: 'object', properties: {}, required: [] },
  category,
  source: 'builtin',
})

function throwingExecutor(message: string, runs: { count: number }) {
  return async () => {
    runs.count++
    throw new Error(message)
  }
}

describe('ToolRegistry.execute — retry discipline (audit B2)', () => {
  it('retries a transient throw for a read-only tool', async () => {
    const registry = new ToolRegistry()
    const runs = { count: 0 }
    registry.registerBuiltin(mkTool('file_read', 'filesystem'), async () => {
      runs.count++
      if (runs.count === 1) throw new Error('fetch failed')
      return 'contents'
    })
    const result = await registry.execute('file_read', {})
    expect(runs.count).toBe(2)
    expect(result).toBe('contents')
  })

  it('never retries a mutating tool, even on a transient throw', async () => {
    const registry = new ToolRegistry()
    const runs = { count: 0 }
    registry.registerBuiltin(mkTool('shell_execute'), throwingExecutor('fetch failed', runs))
    const result = await registry.execute('shell_execute', {})
    expect(runs.count).toBe(1)
    expect(result).toMatch(/^Error:/)
  })

  it('never retries a non-transient throw', async () => {
    const registry = new ToolRegistry()
    const runs = { count: 0 }
    registry.registerBuiltin(mkTool('file_read', 'filesystem'), throwingExecutor('ENOENT: no such file', runs))
    const result = await registry.execute('file_read', {})
    expect(runs.count).toBe(1)
    expect(result).toContain('ENOENT')
  })

  it('never retries an aborted call — the user said stop', async () => {
    const registry = new ToolRegistry()
    const runs = { count: 0 }
    registry.registerBuiltin(mkTool('file_read', 'filesystem'), async () => {
      runs.count++
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    })
    const result = await registry.execute('file_read', {})
    expect(runs.count).toBe(1)
    expect(result).toMatch(/^Error:/)
  })

  it('string-result transient errors still only retry read-only tools', async () => {
    const registry = new ToolRegistry()
    const shellRuns = { count: 0 }
    registry.registerBuiltin(mkTool('shell_execute'), async () => {
      shellRuns.count++
      return 'Error: request timed out'
    })
    await registry.execute('shell_execute', {})
    expect(shellRuns.count).toBe(1)
  })
})
