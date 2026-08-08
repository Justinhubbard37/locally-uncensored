import { backendCall } from '../backend'

export interface RepoMapFile {
  path: string
  score: number
  snippet: string
}

export interface RepoMapResult {
  files: RepoMapFile[]
  count: number
}

export interface FetchRepoMapInput {
  workingDirectory: string
  query?: string
  limit?: number
  signal?: AbortSignal
}

/**
 * Short-lived result cache (audit E4). The Bridge walk visits up to 20k
 * files and parses up to 512 KiB each — and it ran on EVERY instruction,
 * including the follow-up sent twenty seconds after the last one. A repo's
 * import graph does not change meaningfully inside a minute; an agent run
 * that edits files invalidates through the normal TTL expiry.
 */
const REPO_MAP_TTL_MS = 60_000
const repoMapCache = new Map<string, { at: number; result: RepoMapResult }>()

/**
 * Calls the Bridge `repo_map` command. The Bridge walks the working
 * directory, parses imports, runs PageRank, and returns the top-N ranked
 * files.
 */
export async function fetchRepoMap(input: FetchRepoMapInput): Promise<RepoMapResult> {
  if (!input.workingDirectory) {
    return { files: [], count: 0 }
  }
  const cacheKey = `${input.workingDirectory}|${input.query ?? ''}|${input.limit ?? 20}`
  const hit = repoMapCache.get(cacheKey)
  if (hit && Date.now() - hit.at < REPO_MAP_TTL_MS) {
    return hit.result
  }
  // The Rust `repo_map` command takes a SINGLE `args: serde_json::Value` param
  // (deserialized into RepoMapArgs) — so the payload MUST be wrapped in
  // `{ args: … }`. Sending the fields top-level makes Tauri reject the call
  // with "missing required key args", which silently disabled the whole
  // codexRepoMapEnabled pre-fetch (the failure is swallowed by a try/catch in
  // useCodex → log.warn → no repo map). Confirmed live 2026-06-02.
  const out = await backendCall<RepoMapResult>('repo_map', {
    args: {
      workingDirectory: input.workingDirectory,
      query: input.query,
      limit: input.limit ?? 20,
    },
  })
  const result = {
    files: Array.isArray(out.files) ? out.files : [],
    count: typeof out.count === 'number' ? out.count : 0,
  }
  repoMapCache.set(cacheKey, { at: Date.now(), result })
  return result
}

/**
 * Renders the repo-map result as a system-prompt section. Bounded by
 * character count so a 200-file map can't crowd out the user's actual
 * instructions. The format mirrors the Architect plan section — a
 * stable header the editor model can refer back to.
 */
export function renderRepoMapSection(
  result: RepoMapResult,
  opts?: { maxChars?: number },
): string {
  if (!result.files.length) return ''
  const maxChars = opts?.maxChars ?? 2400
  const lines: string[] = []
  lines.push('')
  lines.push('')
  lines.push(
    'REPO MAP — files ranked by import-graph PageRank. Use these as your',
  )
  lines.push('initial reading list before grepping for unrelated files.')
  lines.push('')
  let used = lines.join('\n').length
  for (const f of result.files) {
    const snippet = f.snippet ? ` — ${f.snippet}` : ''
    const row = `- ${f.path}${snippet}`
    if (used + row.length + 1 > maxChars) break
    lines.push(row)
    used += row.length + 1
  }
  return lines.join('\n')
}
