import { describe, it, expect } from 'vitest'
import {
  AGENT_TOOL_DEFS,
  getOllamaTools,
  getToolByName,
  getToolPermission,
} from '../tool-registry'
import { toolRegistry, DEFAULT_PERMISSIONS } from '../mcp'

// Tools whose category is BLOCKED by default are intentionally dropped from
// getOllamaTools (it passes DEFAULT_PERMISSIONS, which excludes blocked
// categories). video_generate is OFF by default as of v2.5.0-polish
// (2026-06-04), so it must not be offered to the model.
const blockedByDefaultNames = new Set(
  toolRegistry
    .getAll()
    .filter((t) => DEFAULT_PERMISSIONS[t.category] === 'blocked')
    .map((t) => t.name),
)
const offeredDefNames = AGENT_TOOL_DEFS
  .map((t) => t.name)
  .filter((n) => !blockedByDefaultNames.has(n))
  .sort()

// ── AGENT_TOOL_DEFS ─────────────────────────────────────────────

describe('AGENT_TOOL_DEFS', () => {
  it('contains exactly 33 tool definitions', () => {
    // Phase 13 v2.4.0: delegate_task added as a builtin (→ 15 tools).
    // v2.5.0 sprint A/B/C from uselu: +13 codex tools — shell_task_*,
    // shell_execute_background, git_*, gh_pr_create, pr_resume,
    // project_init, run_tests (→ 28 tools).
    // v2.5.0 Feature EE: video_generate (text-to-video via the VRAM hand-off
    // orchestrator) added alongside image_generate (→ 29 tools).
    // v2.5.9 M1: file_edit (surgical SEARCH/REPLACE edit) (→ 30 tools).
    // 2026-08-05 audit C4: todo_write — the plan the model keeps and the user
    // sees above the composer (→ 31 tools).
    // 2.6.3 B1 (Morgan): opening a folder or starting a program is NOT a tool.
    // desktop_open and app_launch existed here briefly and were removed on
    // 2026-08-06: they only wrapped `open` / `explorer` / `xdg-open`, cost ~478
    // tokens of every system prompt, and inherited the same confirm gate
    // shell_execute already had, so they bought nothing. The capability lives
    // in shell_execute plus the platform line from lib/host-platform.ts.
    expect(AGENT_TOOL_DEFS).toHaveLength(31)
  })

  const expectedTools = [
    'todo_write',
    'web_search',
    'web_fetch',
    'file_read',
    'file_write',
    'file_edit',
    'file_list',
    'file_search',
    'code_execute',
    'shell_execute',
    'shell_execute_background',
    'shell_task_status',
    'shell_task_kill',
    'shell_task_list',
    'git_status',
    'git_commit',
    'git_push',
    'git_log',
    'git_diff',
    'gh_pr_create',
    'pr_resume',
    'project_init',
    'run_tests',
    'image_generate',
    'video_generate',
    'run_workflow',
    'screenshot',
    'process_list',
    'system_info',
    'get_current_time',
  ]

  it.each(expectedTools)('includes the "%s" tool', (name) => {
    const tool = AGENT_TOOL_DEFS.find((t) => t.name === name)
    expect(tool).toBeDefined()
  })

  it('every tool has name, description, parameters, and permission', () => {
    for (const tool of AGENT_TOOL_DEFS) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.parameters).toBeDefined()
      expect(tool.parameters.type).toBe('object')
      expect(tool.parameters.properties).toBeDefined()
      expect(Array.isArray(tool.parameters.required)).toBe(true)
      expect(['auto', 'confirm']).toContain(tool.permission)
    }
  })

  it('auto-permission tools are the read-only probes plus todo_write', () => {
    const autoTools = AGENT_TOOL_DEFS.filter((t) => t.permission === 'auto')
    const autoNames = autoTools.map((t) => t.name).sort()
    // todo_write is category 'system' (auto) because it only writes the plan
    // shown in the UI. Prompting for approval to write a to-do list would make
    // the feature useless on a long unattended run.
    expect(autoNames).toEqual(['get_current_time', 'process_list', 'system_info', 'todo_write', 'web_fetch', 'web_search'])
  })

  it('confirm-permission tools include file ops, code, shell, image, workflow, screenshot, delegate_task, sprint A/B/C tools', () => {
    const confirmTools = AGENT_TOOL_DEFS.filter((t) => t.permission === 'confirm')
    const confirmNames = confirmTools.map((t) => t.name).sort()
    // Phase 13 v2.4.0: delegate_task added under workflow category (confirm default).
    // v2.5.0 sprint A/B/C from uselu: codex tools default to confirm (writes,
    // shell, git, gh, project_init, run_tests — all touch the user's machine).
    // v2.5.0 Feature EE: video_generate (image category → confirm default).
    expect(confirmNames).toEqual([
      'code_execute', 'delegate_task',
      'file_edit', 'file_list', 'file_read', 'file_search',
      'file_write', 'gh_pr_create', 'git_commit', 'git_diff', 'git_log',
      'git_push', 'git_status', 'image_generate', 'pr_resume', 'project_init',
      'run_tests', 'run_workflow', 'screenshot', 'shell_execute',
      'shell_execute_background', 'shell_task_kill', 'shell_task_list',
      'shell_task_status', 'video_generate',
    ])
  })
})

// ── getOllamaTools ──────────────────────────────────────────────

describe('getOllamaTools', () => {
  it('returns one tool per NON-blocked AGENT_TOOL_DEFS entry', () => {
    const ollamaTools = getOllamaTools()
    // getOllamaTools filters out default-blocked categories (video), so it
    // returns AGENT_TOOL_DEFS minus those.
    expect(ollamaTools).toHaveLength(AGENT_TOOL_DEFS.length - blockedByDefaultNames.size)
  })

  it('includes video_generate (live since v2.5.3) alongside image_generate', () => {
    const names = getOllamaTools().map((t) => t.function.name)
    expect(blockedByDefaultNames.has('video_generate')).toBe(false)
    expect(names).toContain('video_generate')
    expect(names).toContain('image_generate')
  })

  it('each tool has type "function" at the top level', () => {
    const ollamaTools = getOllamaTools()
    for (const tool of ollamaTools) {
      expect(tool.type).toBe('function')
    }
  })

  it('each tool has function.name, function.description, function.parameters', () => {
    const ollamaTools = getOllamaTools()
    for (const tool of ollamaTools) {
      expect(tool.function).toBeDefined()
      expect(tool.function.name).toBeTruthy()
      expect(tool.function.description).toBeTruthy()
      expect(tool.function.parameters).toBeDefined()
    }
  })

  it('preserves (non-blocked) tool names from AGENT_TOOL_DEFS', () => {
    const ollamaTools = getOllamaTools()
    const ollamaNames = ollamaTools.map((t) => t.function.name).sort()
    expect(ollamaNames).toEqual(offeredDefNames)
  })

  it('does not include permission field (Ollama format excludes it)', () => {
    const ollamaTools = getOllamaTools()
    for (const tool of ollamaTools) {
      // The permission field should not leak into the Ollama format
      expect((tool as any).permission).toBeUndefined()
      expect((tool.function as any).permission).toBeUndefined()
    }
  })
})

// ── getToolByName ───────────────────────────────────────────────

describe('getToolByName', () => {
  it('returns the correct tool definition for a known name', () => {
    const tool = getToolByName('web_search')
    expect(tool).toBeDefined()
    expect(tool!.name).toBe('web_search')
    expect(tool!.description).toBeTruthy()
  })

  it('returns undefined for an unknown name', () => {
    expect(getToolByName('nonexistent_tool')).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(getToolByName('')).toBeUndefined()
  })

  it('is case-sensitive', () => {
    expect(getToolByName('Web_Search')).toBeUndefined()
    expect(getToolByName('WEB_SEARCH')).toBeUndefined()
  })
})

// ── getToolPermission ───────────────────────────────────────────

describe('getToolPermission', () => {
  it('returns "auto" for auto-permission tools', () => {
    expect(getToolPermission('web_search')).toBe('auto')
    expect(getToolPermission('web_fetch')).toBe('auto')
    expect(getToolPermission('process_list')).toBe('auto')
    expect(getToolPermission('system_info')).toBe('auto')
  })

  it('returns "confirm" for confirm-permission tools', () => {
    expect(getToolPermission('file_read')).toBe('confirm')
    expect(getToolPermission('file_write')).toBe('confirm')
    expect(getToolPermission('code_execute')).toBe('confirm')
    expect(getToolPermission('image_generate')).toBe('confirm')
    expect(getToolPermission('shell_execute')).toBe('confirm')
  })

  it('defaults to "confirm" for unknown tools', () => {
    expect(getToolPermission('unknown_tool')).toBe('confirm')
    expect(getToolPermission('')).toBe('confirm')
  })
})
