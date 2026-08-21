/**
 * 2.6.6 tool merge (plan E4/E5): the sixteen typed wrappers are gone from the
 * catalog, but their NAMES must keep working. A restored session, or a model
 * that knows git_status from its own training, calls the old name; burning
 * that step on "Unknown tool" would be a regression users feel immediately.
 *
 * And the read-only gate moved with them: it used to strip tools by NAME,
 * now shell_execute stays offered on /review turns and the executor refuses
 * by COMMAND. These tests pin both halves at the executor, where they run.
 *
 * Run: npx vitest run src/api/mcp/__tests__/tool-merge-redirect.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const backendCalls: { cmd: string; body: any }[] = []

vi.mock('../../backend', () => ({
  backendCall: vi.fn(async (cmd: string, body: any) => {
    backendCalls.push({ cmd, body })
    if (cmd === 'shell_execute') {
      return { stdout: '# branch.head master\n', stderr: '', exitCode: 0 }
    }
    return { ok: true }
  }),
  fetchExternal: vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })),
}))
// The delegate/workflow imports drag in the provider stack, which the
// redirect under test never touches. Stub them to keep the module loadable.
vi.mock('../../agents/sub-agent', () => ({
  DELEGATE_TASK_TOOL_DEF: { name: 'delegate_task', description: '', category: 'system', inputSchema: {} },
  buildDelegateExecutor: () => async () => 'stub',
}))
vi.mock('../../../lib/workflow-engine', () => ({ WorkflowEngine: class {} }))

import { runRetiredTool, RETIRED_TOOL_NAMES, registerBuiltinTools } from '../builtin-tools'
import { ToolRegistry } from '../tool-registry'
import { setReadOnlyShellTurn } from '../../agent-context'

beforeEach(() => {
  backendCalls.length = 0
  setReadOnlyShellTurn(false)
})
afterEach(() => setReadOnlyShellTurn(false))

describe('retired names still execute through the redirect', () => {
  it('git_status runs the real shell command and carries the retirement note', async () => {
    const result = await runRetiredTool('git_status', {})
    expect(result).not.toBeNull()
    expect(backendCalls.some((c) => c.cmd === 'shell_execute' && String(c.body.command).startsWith('git status'))).toBe(true)
    expect(result).toContain('git_status is retired')
    expect(result).toContain('shell_execute')
  })

  it('a name that was never ours returns null, so the registry can say Unknown tool', async () => {
    expect(await runRetiredTool('made_up_tool', {})).toBeNull()
  })

  it('all sixteen retired names resolve', () => {
    expect(RETIRED_TOOL_NAMES.size).toBe(16)
    for (const name of ['git_status', 'git_log', 'git_diff', 'git_commit', 'git_push', 'run_tests',
      'gh_pr_create', 'project_init', 'code_execute', 'system_info', 'process_list',
      'get_current_time', 'shell_execute_background', 'shell_task_status', 'shell_task_kill', 'shell_task_list']) {
      expect(RETIRED_TOOL_NAMES.has(name), name).toBe(true)
    }
  })
})

describe('the read-only gate lives at the executor now', () => {
  it('a mutating retired name is refused on a read-only turn', async () => {
    setReadOnlyShellTurn(true)
    const result = await runRetiredTool('git_commit', { message: 'x' })
    expect(result).toContain('Refused')
    expect(result).toContain('read-only')
    expect(backendCalls).toHaveLength(0)
  })

  it('a read-only retired name still runs on a read-only turn', async () => {
    setReadOnlyShellTurn(true)
    const result = await runRetiredTool('git_status', {})
    expect(result).not.toContain('Refused')
    expect(backendCalls.some((c) => c.cmd === 'shell_execute')).toBe(true)
  })

  it('negative control: the same commit runs when the turn is not read-only', async () => {
    const result = await runRetiredTool('git_commit', { message: 'x' })
    expect(result).not.toContain('Refused: this turn is read-only')
  })
})

describe('shell_execute refuses by COMMAND on a read-only turn (E7 priority)', () => {
  const registry = new ToolRegistry()
  registerBuiltinTools(registry)
  const shell = (args: Record<string, any>) => registry.execute('shell_execute', args)

  it('the reviewer can still look at the diff', async () => {
    setReadOnlyShellTurn(true)
    const result = await shell({ command: 'git diff --stat' })
    expect(result).not.toContain('Refused')
    expect(backendCalls.some((c) => c.cmd === 'shell_execute' && c.body.command === 'git diff --stat')).toBe(true)
  })

  it('git commit is refused', async () => {
    setReadOnlyShellTurn(true)
    const result = await shell({ command: 'git commit -m x' })
    expect(result).toContain('Refused')
    expect(backendCalls).toHaveLength(0)
  })

  it('chaining a read prefix onto a write does not slip through', async () => {
    setReadOnlyShellTurn(true)
    const result = await shell({ command: 'git log; rm -rf x' })
    expect(result).toContain('Refused')
    expect(backendCalls).toHaveLength(0)
  })

  it('background starts and task kills are refused too, status stays allowed', async () => {
    setReadOnlyShellTurn(true)
    expect(await shell({ command: 'git log', background: true })).toContain('Refused')
    expect(await shell({ task: 'kill', task_id: 't1' })).toContain('Refused')
    const status = await shell({ task: 'status', task_id: 't1' })
    expect(status).not.toContain('Refused')
  })

  it('negative control: the same commit runs on a normal turn', async () => {
    setReadOnlyShellTurn(false)
    const result = await shell({ command: 'git commit -m x' })
    expect(result).not.toContain('Refused')
    expect(backendCalls.some((c) => c.body?.command === 'git commit -m x')).toBe(true)
  })
})

// Live E2E 2026-08-21: the model emitted git_log on the Code surface and got
// "Unknown tool: git_log" back. The redirect lived only in registry.execute();
// the step executor's own getTool miss failed the call before execute() ran.
// These tests pin the whole executor path, not just the registry.
describe('retired names survive the step executor (executeParallel)', () => {
  const registry = new ToolRegistry()
  registerBuiltinTools(registry)
  const runtime = {
    getTool: (name: string) => registry.resolveExecutable(name),
    execute: ((name: string, args: Record<string, any>) => registry.execute(name, args)) as any,
  }

  it('resolveExecutable: registered def, retired stub, unknown undefined', () => {
    expect(registry.resolveExecutable('shell_execute')?.inputSchema).toBeTruthy()
    expect(registry.resolveExecutable('git_log')).toEqual({ name: 'git_log' })
    expect(registry.resolveExecutable('made_up_tool')).toBeUndefined()
  })

  it('git_log through executeParallel completes via the redirect', async () => {
    const { executeParallel } = await import('../../agents/tool-executor')
    const [res] = await executeParallel(
      [{ id: 'r1', toolName: 'git_log', args: {} }],
      runtime,
    )
    expect(res.status).toBe('completed')
    expect(res.result).toContain('git_log is retired')
    expect(backendCalls.some((c) => c.cmd === 'shell_execute' && String(c.body.command).startsWith('git log'))).toBe(true)
  })

  it('negative control: a name that was never ours still fails as Unknown tool', async () => {
    const { executeParallel } = await import('../../agents/tool-executor')
    const [res] = await executeParallel(
      [{ id: 'r2', toolName: 'made_up_tool', args: {} }],
      runtime,
    )
    expect(res.status).toBe('failed')
    expect(res.error).toContain('Unknown tool')
  })

  it('drift guard: the lib list and the executor map name the same tools', async () => {
    const { RETIRED_EXECUTOR_NAMES } = await import('../builtin-tools')
    const { RETIRED_TOOL_NAMES: libNames } = await import('../../../lib/retired-tools')
    expect([...libNames].sort()).toEqual([...RETIRED_EXECUTOR_NAMES].sort())
  })
})
