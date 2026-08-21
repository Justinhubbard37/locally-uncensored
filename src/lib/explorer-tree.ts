/**
 * Tree logic for the coding Explorer panel (2.6.6 C3).
 *
 * The old file panel was a one-level listing that REPLACED the workspace root
 * on every folder click, so opening `src/` moved the agent's jail with it and
 * the way back was a string split on "/" that breaks on a Windows backslash
 * (plan R2). Here the root is picked once and every expand is a lazy listing
 * of ONE node underneath it: `workingDirectory` stays the picked root, so the
 * jail never moves, and no path is ever taken apart in the frontend. Every
 * path the panel uses comes back from the backend verbatim.
 *
 * The panel calls `fs_list` DIRECTLY (never the model's tool executor) for the
 * same reason the old one did: a model-supplied workingDirectory must never be
 * able to pick its own jail root (security review 2.5.7).
 */

export interface ExplorerNode {
  name: string
  path: string
  isDirectory: boolean
  size?: number
}

/** Folders that turn a real repo into an unusable tree. A single npm install
 *  is 30k+ entries, which is 60 times the backend cap on its own. */
export const EXPLORER_IGNORED: readonly string[] = ['node_modules', '.git', 'target', 'dist']

/** filesystem.rs stops a listing at 500 entries (`max_entries`). The panel has
 *  to say so, otherwise a big folder silently looks complete. */
export const FS_LIST_CAP = 500

export function isIgnoredEntry(name: string): boolean {
  return EXPLORER_IGNORED.includes(name)
}

export interface ExplorerListing {
  nodes: ExplorerNode[]
  /** The backend hit its 500 cap, so this listing is a prefix, not the folder. */
  truncated: boolean
  /** How many entries the ignore filter took out, for the muted hint row. */
  hidden: number
}

export const EMPTY_LISTING: ExplorerListing = { nodes: [], truncated: false, hidden: 0 }

/** Separator-agnostic comparison form. This normalises for COMPARING two
 *  backend paths; it never derives a new path from an old one. */
function comparable(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  // Windows paths compare case-insensitively (drive prefix or UNC share).
  if (/^[a-zA-Z]:/.test(slashed) || slashed.startsWith('//')) return slashed.toLowerCase()
  return slashed
}

/** True when `candidate` is the workspace root itself or sits underneath it.
 *  The real jail lives in Rust (`resolve_path` / `contain_within`); this is the
 *  frontend half, so the panel never even asks for a file it may not show. */
export function isWithinRoot(root: string, candidate: string): boolean {
  if (!root || !root.trim() || !candidate || !candidate.trim()) return false
  // A ".." segment means the string says one thing and the filesystem another.
  if (/(^|[\\/])\.\.([\\/]|$)/.test(candidate)) return false
  const r = comparable(root)
  const c = comparable(candidate)
  if (c === r) return true
  return c.startsWith(r === '' ? '/' : `${r}/`)
}

function sortNodes(nodes: ExplorerNode[]): ExplorerNode[] {
  return [...nodes].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/** Turn a raw `fs_list` answer into a listing: ignore filter, folders first,
 *  and the truncation flag the panel shows. */
export function parseListing(data: unknown): ExplorerListing {
  const raw = (data as { entries?: unknown } | null)?.entries
  const entries: unknown[] = Array.isArray(raw) ? raw : []
  const mapped: ExplorerNode[] = []
  let hidden = 0
  for (const entry of entries) {
    const e = entry as { name?: unknown; path?: unknown; isDir?: unknown; size?: unknown }
    const name = typeof e?.name === 'string' ? e.name : ''
    const path = typeof e?.path === 'string' ? e.path : ''
    if (!name || !path) continue
    if (isIgnoredEntry(name)) {
      hidden += 1
      continue
    }
    mapped.push({
      name,
      path,
      isDirectory: !!e?.isDir,
      size: typeof e?.size === 'number' ? e.size : undefined,
    })
  }
  return { nodes: sortNodes(mapped), truncated: entries.length >= FS_LIST_CAP, hidden }
}

export type FsList = (args: {
  path: string
  recursive: boolean
  pattern: null
  workingDirectory: string
}) => Promise<unknown>

/**
 * Lazily list ONE directory node. `workingDirectory` stays the picked root for
 * every node in the tree, so expanding a subfolder does not move the jail, and
 * a path outside the root is refused before the backend is even asked.
 */
export async function loadChildren(
  dir: string,
  root: string,
  fsList: FsList,
): Promise<ExplorerListing> {
  if (!isWithinRoot(root, dir)) {
    throw new Error('Path is outside the workspace root')
  }
  const data = await fsList({ path: dir, recursive: false, pattern: null, workingDirectory: root })
  const listing = parseListing(data)
  // A symlink can point anywhere; the backend answers with the link's own path,
  // so drop anything that does not sit under the root the user picked.
  const inside = listing.nodes.filter((n) => isWithinRoot(root, n.path))
  return { ...listing, nodes: inside }
}

export function toggleExpanded(expanded: readonly string[], path: string): string[] {
  return expanded.includes(path) ? expanded.filter((p) => p !== path) : [...expanded, path]
}

export interface TreeRow {
  node: ExplorerNode
  depth: number
  expanded: boolean
}

/**
 * Flatten the loaded listings into the rows the panel renders. A folder only
 * contributes children when it is expanded AND its listing has been loaded,
 * which is what makes the loading lazy in the first place.
 */
export function flattenTree(
  root: string,
  listings: Readonly<Record<string, ExplorerListing | undefined>>,
  expanded: readonly string[],
): TreeRow[] {
  const rows: TreeRow[] = []
  const seen = new Set<string>()
  const walk = (dir: string, depth: number) => {
    const key = comparable(dir)
    if (seen.has(key)) return
    seen.add(key)
    const listing = listings[dir]
    if (!listing) return
    for (const node of listing.nodes) {
      const isOpen = node.isDirectory && expanded.includes(node.path)
      rows.push({ node, depth, expanded: isOpen })
      if (isOpen) walk(node.path, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}
