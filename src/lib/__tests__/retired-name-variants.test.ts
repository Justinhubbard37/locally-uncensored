/**
 * A9, the rest of the retired names.
 *
 * The 2.6.6 merge kept the sixteen old names running: the registry redirects
 * them and the result carries a one-line note pointing at the new call form.
 * Two holes were left in that promise, and both cost a whole step each time
 * they were hit.
 *
 *   1. Only a SPOTLESS name reached the redirect. `functions.git_status` (the
 *      harmony recipient namespace, captured live on gpt-oss via LU Cloud) and
 *      `run_code` (a spelling models bring from elsewhere) went through
 *      canonicalToolName, matched nothing in `known`, and arrived at the
 *      executor unchanged, where they failed as "Unknown tool". The repair
 *      ladder for decorated names existed; it just stopped at the registered
 *      catalog.
 *
 *   2. The registry answers 'confirm' for anything it cannot find, so in Agent
 *      mode every retired name raised an approval dialog. Including
 *      `git_status`, whose entire executor is one fixed
 *      `git status --porcelain=2 --branch`. A dialog for a read, on a name the
 *      model only used because its own context taught it the old spelling.
 *
 * The negative controls matter more than usual here: the fix must not let a
 * name be rerouted AWAY from a live tool, and must not hand a mutating name an
 * unattended run.
 *
 * Run: npx vitest run src/lib/__tests__/retired-name-variants.test.ts
 */
import { describe, it, expect } from 'vitest'
import { canonicalToolName, parseLooseToolCalls } from '../loose-tool-parse'
import {
  RETIRED_TOOL_NAMES,
  RETIRED_MUTATING_NAMES,
  isRetiredReadOnly,
  retiredPermissionLevel,
} from '../retired-tools'
import { DEFAULT_PERMISSIONS } from '../../api/mcp/types'
import type { PermissionMap } from '../../api/mcp/types'

/** The coding catalog as it stands after the merge: no retired name in it. */
const KNOWN = [
  'file_read', 'file_write', 'file_edit', 'file_list', 'file_search',
  'shell_execute', 'web_search', 'web_fetch', 'todo_write', 'pr_resume',
  'image_generate', 'video_generate', 'run_workflow', 'delegate_task', 'screenshot',
]

describe('canonicalToolName maps the variants onto the retired map', () => {
  it('the plain name, which the registry already redirected', () => {
    expect(canonicalToolName('git_status', KNOWN)).toBe('git_status')
  })

  it.each([
    ['functions.git_status', 'git_status'],
    ['functions.git_commit', 'git_commit'],
    ['functions.run_tests', 'run_tests'],
  ])('the harmony recipient namespace: %s', (sent, want) => {
    expect(canonicalToolName(sent, KNOWN)).toBe(want)
  })

  it.each([
    ['git_status<|channel|>commentary', 'git_status'],
    ['git_log<|constrain|>json', 'git_log'],
    ['functions.git_diff<|channel|>commentary', 'git_diff'],
  ])('a leaked control token welded onto the name: %s', (sent, want) => {
    expect(canonicalToolName(sent, KNOWN)).toBe(want)
  })

  it.each([
    ['run_code', 'code_execute'],
    ['execute_code', 'code_execute'],
    ['run_python', 'code_execute'],
    ['run_test', 'run_tests'],
    ['list_processes', 'process_list'],
    ['current_time', 'get_current_time'],
  ])('a near-miss spelling a model brought from elsewhere: %s', (sent, want) => {
    expect(canonicalToolName(sent, KNOWN)).toBe(want)
  })

  it.each([
    ['gitStatus', 'git_status'],
    ['git-status', 'git_status'],
    ['GIT_STATUS', 'git_status'],
    ['git status', 'git_status'],
    ['shell task list', 'shell_task_list'],
  ])('casing and punctuation: %s', (sent, want) => {
    expect(canonicalToolName(sent, KNOWN)).toBe(want)
  })

  it('every retired name survives its own namespace prefix', () => {
    for (const name of RETIRED_TOOL_NAMES) {
      expect(canonicalToolName(`functions.${name}`, KNOWN), name).toBe(name)
    }
  })

  // ── negative controls ──

  it('a registered tool always wins over a retired one', () => {
    // shell_execute is live and code_execute is retired. A catalog that still
    // had code_execute would be a different question; this one must never
    // reroute a live name.
    expect(canonicalToolName('shell_execute', KNOWN)).toBe('shell_execute')
    expect(canonicalToolName('functions.shell_execute', KNOWN)).toBe('shell_execute')
    expect(canonicalToolName('run_shell', KNOWN)).toBe('shell_execute')
    // And with code_execute BACK in the known list it resolves there, not
    // through the retired ladder, because known is walked first.
    expect(canonicalToolName('run_code', [...KNOWN, 'code_execute'])).toBe('code_execute')
  })

  it('a name that was never ours still comes back unchanged', () => {
    expect(canonicalToolName('teleport', KNOWN)).toBe('teleport')
    expect(canonicalToolName('functions.teleport', KNOWN)).toBe('functions.teleport')
    expect(canonicalToolName('git_blame', KNOWN)).toBe('git_blame')
    expect(canonicalToolName('', KNOWN)).toBe('')
  })

  it('an MCP tool whose real name carries dots is left alone', () => {
    const mcp = [...KNOWN, 'mcp.server.git_status']
    expect(canonicalToolName('mcp.server.git_status', mcp)).toBe('mcp.server.git_status')
  })
})

describe('the loose parse lifts a retired name out of prose', () => {
  it('function syntax, which is how the weak models write it', () => {
    const { calls } = parseLooseToolCalls('Let me check: git_log(limit=5)', KNOWN)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('git_log')
    expect(calls[0].arguments).toEqual({ limit: 5 })
  })

  it('a JSON object naming a retired tool', () => {
    const { calls } = parseLooseToolCalls('{"name":"git_status","arguments":{"cwd":"."}}', KNOWN)
    expect(calls.map((c) => c.name)).toEqual(['git_status'])
  })

  it('the bare-name-plus-brace form', () => {
    const { calls } = parseLooseToolCalls('[run_tests {"path": "src"}]', KNOWN)
    expect(calls.map((c) => c.name)).toEqual(['run_tests'])
  })

  it('negative control: prose that only mentions a retired name is not a call', () => {
    const { calls } = parseLooseToolCalls('I would normally use git_status here.', KNOWN)
    expect(calls).toEqual([])
  })

  it('negative control: an unknown name in the same shape is still ignored', () => {
    const { calls } = parseLooseToolCalls('teleport(target="mars")', KNOWN)
    expect(calls).toEqual([])
  })
})

describe('the permission a retired name resolves to', () => {
  const perms = DEFAULT_PERMISSIONS

  it('the split covers every retired name exactly once', () => {
    for (const n of RETIRED_MUTATING_NAMES) expect(RETIRED_TOOL_NAMES.has(n), n).toBe(true)
    const readOnly = [...RETIRED_TOOL_NAMES].filter(isRetiredReadOnly)
    expect(readOnly.length + RETIRED_MUTATING_NAMES.size).toBe(RETIRED_TOOL_NAMES.size)
    expect(readOnly.sort()).toEqual([
      'get_current_time', 'git_diff', 'git_log', 'git_status',
      'process_list', 'shell_task_list', 'shell_task_status', 'system_info',
    ])
  })

  it('a read-only retired name runs unattended', () => {
    // DEFAULT_PERMISSIONS has terminal on 'confirm'; that is the dialog the
    // user had to click through for a `git status`.
    expect(perms.terminal).toBe('confirm')
    for (const n of ['git_status', 'git_log', 'git_diff', 'shell_task_status', 'shell_task_list']) {
      expect(retiredPermissionLevel(n, perms), n).toBe('auto')
    }
  })

  it('a mutating retired name still asks', () => {
    for (const n of ['git_commit', 'git_push', 'gh_pr_create', 'project_init', 'run_tests',
      'code_execute', 'shell_execute_background', 'shell_task_kill']) {
      expect(retiredPermissionLevel(n, perms), n).toBe('confirm')
    }
  })

  it('a blocked category blocks the redirect too, on both halves', () => {
    const blocked: PermissionMap = { ...perms, terminal: 'blocked', system: 'blocked' }
    expect(retiredPermissionLevel('git_status', blocked)).toBe('blocked')
    expect(retiredPermissionLevel('git_commit', blocked)).toBe('blocked')
    expect(retiredPermissionLevel('system_info', blocked)).toBe('blocked')
  })

  it('the three system probes read the system category, not terminal', () => {
    // They redirect into a backend probe, not a shell, and that is the
    // category they always had. Blocking the terminal must not take the clock
    // with it, and blocking system must not leave them running.
    const noTerminal: PermissionMap = { ...perms, terminal: 'blocked' }
    for (const n of ['system_info', 'process_list', 'get_current_time']) {
      expect(retiredPermissionLevel(n, noTerminal), n).toBe('auto')
    }
    const noSystem: PermissionMap = { ...perms, system: 'blocked' }
    expect(retiredPermissionLevel('system_info', noSystem)).toBe('blocked')
    expect(retiredPermissionLevel('git_status', noSystem)).toBe('auto')
  })

  it('negative control: a name that was never ours gets no answer here', () => {
    expect(retiredPermissionLevel('teleport', perms)).toBeUndefined()
    expect(retiredPermissionLevel('shell_execute', perms)).toBeUndefined()
    expect(retiredPermissionLevel('', perms)).toBeUndefined()
  })
})
