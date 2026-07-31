/**
 * Intelligent Tool Selection — reduce token usage by only including relevant tools.
 *
 * Instead of sending all 13 tools in every request (wasting context),
 * analyze the user message and only include tools likely to be needed.
 * Saves up to 80% of tool-definition tokens.
 */

import type { MCPToolDefinition, PermissionMap } from '../api/mcp/types'

interface ToolGroup {
  keywords: string[]
  tools: string[]
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    // Web search intents. Only EXPLICIT web cues route here. Bare 'search',
    // 'latest', 'current', 'aktuell', 'neueste', 'suche' were removed: they
    // collide head-on with coding intents ("search the codebase", "fix the
    // current bug", "the latest changes"), which used to pull web_search+
    // web_fetch, inflate the selection past 3, and silently skip the file-tool
    // booster below — leaving a coding turn with no file_search/file_list.
    // German phrases kept as multi-word cues ("such im internet", "im internet")
    // so a real "such im internet nach…" still surfaces web_search.
    keywords: ['find online', 'look up', 'look it up', 'google', 'bing', 'duckduckgo', 'internet',
      'news', 'web search', 'websearch', 'search online', 'search the web', 'browse', 'website', 'webseite',
      'url', 'http://', 'https://', 'weather', 'wetter',
      'such nach', 'such im', 'im internet', 'recherch', 'nachrichten', 'neueste'],
    tools: ['web_search', 'web_fetch'],
  },
  {
    keywords: ['read', 'open', 'show', 'cat', 'content of', 'what does', 'look at', 'check file'],
    tools: ['file_read'],
  },
  {
    keywords: ['write', 'create', 'save', 'make a file', 'put', 'generate file', 'output to',
      'edit', 'modify', 'change', 'replace', 'update', 'refactor', 'rename', 'fix', 'patch'],
    // file_edit (surgical) is preferred for changing existing files; file_write
    // for new files / full rewrites. Both surfaced so the model can pick.
    tools: ['file_write', 'file_edit'],
  },
  {
    keywords: ['list', 'ls', 'dir', 'files in', 'directory', 'folder', 'what files', 'tree'],
    tools: ['file_list'],
  },
  {
    keywords: ['search file', 'grep', 'find in', 'contains', 'where is', 'which file'],
    tools: ['file_search'],
  },
  {
    keywords: ['run', 'execute', 'command', 'shell', 'terminal', 'bash', 'powershell', 'npm', 'git', 'pip', 'node', 'python', 'install', 'build', 'test', 'compile'],
    tools: ['shell_execute', 'code_execute'],
  },
  {
    keywords: ['system', 'os', 'cpu', 'ram', 'memory', 'process', 'running', 'hostname'],
    tools: ['system_info', 'process_list'],
  },
  {
    keywords: ['screenshot', 'screen', 'desktop', 'capture', 'see my screen'],
    tools: ['screenshot'],
  },
  {
    // Creative image/video. Surface BOTH generators for any creative request so
    // the model can chain image → video in one conversation (David: "ein Video
    // aus dem Bild soll die LLM auch machen können"). Without video_generate
    // here the keyword path dropped it (it was in no group + not ALWAYS_INCLUDE),
    // so a "now animate it" follow-up had no tool to call.
    keywords: ['image', 'picture', 'generate image', 'draw', 'create image', 'bild', 'foto', 'zeichne',
      'video', 'animate', 'animation', 'clip', 'mp4', 'make a video', 'turn into a video', 'movie', 'gif', 'animiere'],
    tools: ['image_generate', 'video_generate'],
  },
  {
    keywords: ['workflow', 'run workflow', 'automate'],
    tools: ['run_workflow'],
  },
  {
    keywords: ['time', 'date', 'day', 'today', 'datum', 'heute', 'tag', 'uhrzeit', 'jetzt', 'now', 'clock', 'hour', 'minute', 'timezone', 'zeitzone'],
    tools: ['get_current_time'],
  },
]

// Tools that should always be available regardless of the prompt — they're
// cheap to include, commonly useful, and often needed mid-run (e.g. after
// a tool result reveals the user really wanted a file read). Keeping
// `get_current_time` here means the agent NEVER has to fall back to web
// for a trivial date question just because the keyword list missed.
export const ALWAYS_INCLUDE = ['file_read', 'file_write', 'file_edit', 'get_current_time']

/** Tool count at which embedding-based routing becomes worth the round trip. */
export const EMBEDDING_ROUTING_THRESHOLD = 15

import type { EmbeddingFn } from '../api/agents/embedding-router'
import { selectToolsByEmbedding } from '../api/agents/embedding-router'

/**
 * Select relevant tools based on user message content.
 * Returns a filtered list of tool names.
 */
export function selectRelevantTools(
  userMessage: string,
  allTools: MCPToolDefinition[],
  permissions: PermissionMap,
  maxTools?: number,
): MCPToolDefinition[] {
  const msg = userMessage.toLowerCase()
  const selectedNames = new Set<string>(ALWAYS_INCLUDE)

  // Match tool groups by keywords
  for (const group of TOOL_GROUPS) {
    if (group.keywords.some(kw => msg.includes(kw))) {
      group.tools.forEach(t => selectedNames.add(t))
    }
  }

  // External (MCP) tools can never match TOOL_GROUPS — the groups only know
  // the builtin names, so on this path a connected server's tools were
  // unreachable no matter what the user typed. Connecting the server is
  // itself the signal that its tools are wanted: always offer them.
  for (const t of allTools) {
    if (t.source === 'external') selectedNames.add(t.name)
  }

  // A tool the user names verbatim is always offered, builtin or external.
  for (const t of allTools) {
    if (msg.includes(t.name.toLowerCase())) selectedNames.add(t.name)
  }

  // If nothing beyond the always-included tools matched, include a broad set
  // (model might need flexibility). Handles generic messages like "help me with
  // this project". Threshold is ALWAYS_INCLUDE.length so adding an always-tool
  // (e.g. file_edit) doesn't silently disable this fallback.
  if (selectedNames.size <= ALWAYS_INCLUDE.length) {
    // Include common tools for generic requests
    selectedNames.add('shell_execute')
    selectedNames.add('file_list')
    selectedNames.add('file_search')
    selectedNames.add('web_search')
  }

  // Coding-discovery safety net (independent of the total count above). Any
  // message that surfaced a shell / code / file tool but lacks the file-
  // discovery pair cannot actually explore the codebase: "run the tests and
  // find the failing spec" matches shell_execute, pushes the count past 3, and
  // would otherwise skip the booster — leaving no file_search/file_list. Add
  // the discovery trio (never web_search) so coding intents can always locate
  // files, which is exactly what CODEX_SYSTEM_PROMPT tells the model to do.
  const hasCodeSignal =
    selectedNames.has('shell_execute') ||
    selectedNames.has('code_execute') ||
    selectedNames.has('file_search') ||
    selectedNames.has('file_list')
  if (hasCodeSignal) {
    selectedNames.add('shell_execute')
    selectedNames.add('file_list')
    selectedNames.add('file_search')
  }

  // Filter by permissions (blocked categories excluded)
  const available = allTools.filter(t => permissions[t.category] !== 'blocked')

  // Return only selected tools that are available
  const selected = available.filter(t => selectedNames.has(t.name))

  // Safety: if nothing matched at all, return all available tools
  if (selected.length === 0) return applyMaxTools(available, maxTools)

  // Small-Model Mode (Knob 1): cap the catalog when maxTools is set. No-op
  // (returns `selected` unchanged) when unset — default behaviour preserved.
  return applyMaxTools(selected, maxTools, undefined, mentionedToolNames(userMessage, allTools))
}

/** Names of tools the message mentions verbatim (case-insensitive). */
function mentionedToolNames(userMessage: string, tools: MCPToolDefinition[]): string[] {
  const msg = userMessage.toLowerCase()
  return tools.filter((t) => msg.includes(t.name.toLowerCase())).map((t) => t.name)
}

/**
 * Hard-cap a tool list to `maxTools` entries (Small-Model Mode, Knob 1).
 * ALWAYS_INCLUDE tools are kept first (cheap + often needed mid-run); the
 * remainder fills from the incoming order, or from `rankOrder` when supplied
 * (the embedding-ranked names from the async path) so the most semantically
 * relevant tools survive the cut. Strict no-op when `maxTools` is unset or
 * the list already fits — big models keep the exact original list + order.
 *
 * Evidence: tool-catalog length is the confirmed killer for small models
 * (LongFuncEval arXiv 2505.10570 — 8B models lose 7.6-85.6% as the catalog
 * grows). Fewer tools is the single biggest fine-tuning-free win.
 */
export function applyMaxTools(
  defs: MCPToolDefinition[],
  maxTools?: number,
  rankOrder?: string[],
  pinned?: string[],
): MCPToolDefinition[] {
  if (!maxTools || maxTools <= 0 || defs.length <= maxTools) return defs
  // Pinned tools (named verbatim by the user) rank with ALWAYS_INCLUDE and
  // may push past maxTools: an explicit mention outranks the budget.
  const keep = (t: MCPToolDefinition) =>
    ALWAYS_INCLUDE.includes(t.name) || (pinned?.includes(t.name) ?? false)
  const always = defs.filter(keep)
  let rest = defs.filter((t) => !keep(t))
  if (rankOrder && rankOrder.length > 0) {
    const idx = (name: string) => {
      const i = rankOrder.indexOf(name)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    rest = [...rest].sort((a, b) => idx(a.name) - idx(b.name))
  }
  const out = [...always]
  for (const t of rest) {
    if (out.length >= maxTools) break
    out.push(t)
  }
  return out
}

/**
 * Embedding-aware variant (Phase 9 v2.4.0). When `embed` is provided AND
 * the permission-filtered tool count exceeds EMBEDDING_ROUTING_THRESHOLD,
 * rank tools by semantic similarity to the user message and union the
 * result with the keyword-based selection (belt + braces). When `embed`
 * is absent, throws, or fails, silently falls back to the keyword-only
 * path.
 */
export async function selectRelevantToolsAsync(
  userMessage: string,
  allTools: MCPToolDefinition[],
  permissions: PermissionMap,
  opts?: { embed?: EmbeddingFn; embeddingThreshold?: number; topN?: number; maxTools?: number },
): Promise<MCPToolDefinition[]> {
  const threshold = opts?.embeddingThreshold ?? EMBEDDING_ROUTING_THRESHOLD
  const available = allTools.filter((t) => permissions[t.category] !== 'blocked')
  const pinned = mentionedToolNames(userMessage, available)
  if (!opts?.embed || available.length <= threshold) {
    return applyMaxTools(selectRelevantTools(userMessage, allTools, permissions), opts?.maxTools, undefined, pinned)
  }
  try {
    const semanticNames = await selectToolsByEmbedding(
      userMessage,
      available.map((t) => ({ name: t.name, description: t.description })),
      opts.embed,
      { topN: opts.topN ?? 10, alwaysInclude: ALWAYS_INCLUDE },
    )
    const keyword = selectRelevantTools(userMessage, allTools, permissions)
    const union = new Set<string>([...semanticNames, ...keyword.map((t) => t.name)])
    const selected = available.filter((t) => union.has(t.name))
    // Small-Model Mode (Knob 1): cap the union to maxTools, filling from
    // embedding-rank order so the most relevant tools survive. No-op when
    // maxTools is unset → `selected` (and its original order) is returned
    // byte-identical, so big-model behaviour is unchanged. Verbatim-named
    // tools are pinned past the cap on both paths.
    return applyMaxTools(selected, opts.maxTools, semanticNames, pinned)
  } catch {
    return applyMaxTools(selectRelevantTools(userMessage, allTools, permissions), opts?.maxTools, undefined, pinned)
  }
}
