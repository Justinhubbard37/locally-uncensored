/**
 * The right column of the Code tab (2.6.6 C2 + C3): the model's plan on top, a
 * real lazy file tree below it, and the preview of a clicked file underneath.
 *
 * What changed against the old FileTree:
 *   - Folders EXPAND in place. They used to replace the workspace root, which
 *     moved the agent's jail every time somebody browsed, and the way back was
 *     a string split on "/" that breaks on a Windows backslash (plan R2). The
 *     root is now set by the picker only, and every listing carries it as
 *     `workingDirectory`.
 *   - node_modules, .git, target and dist are filtered, and the backend's
 *     500-entry cap is shown instead of silently looking complete.
 *   - The panel is resizable and collapsible, and remembers both (uiStore).
 *
 * Like before, the panel calls `fs_list` DIRECTLY and never the model's tool
 * executor, so a model-supplied workingDirectory can never pick its own jail
 * root (security review 2.5.7).
 */

import { Fragment, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
} from 'lucide-react'
import { useCodexStore } from '../../stores/codexStore'
import { useUIStore } from '../../stores/uiStore'
import { backendCall, isTauri, isMacOS } from '../../api/backend'
import {
  EMPTY_LISTING,
  EXPLORER_IGNORED,
  FS_LIST_CAP,
  flattenTree,
  loadChildren,
  toggleExpanded,
  type ExplorerListing,
  type ExplorerNode,
  type FsList,
} from '../../lib/explorer-tree'
import { PlanBar } from './PlanBar'
import { FilePreview } from './FilePreview'

const fsList: FsList = (args) => backendCall('fs_list', args as unknown as Record<string, unknown>)

export function ExplorerPanel() {
  const root = useCodexStore((s) => s.workingDirectory)
  const setWorkingDirectory = useCodexStore((s) => s.setWorkingDirectory)
  const fileTreeVersion = useCodexStore((s) => s.fileTreeVersion)

  const width = useUIStore((s) => s.explorerWidth)
  const collapsed = useUIStore((s) => s.explorerCollapsed)
  const setExplorerWidth = useUIStore((s) => s.setExplorerWidth)
  const setExplorerCollapsed = useUIStore((s) => s.setExplorerCollapsed)

  const [listings, setListings] = useState<Record<string, ExplorerListing>>({})
  const [expanded, setExpanded] = useState<string[]>([])
  const [busy, setBusy] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ExplorerNode | null>(null)

  const load = async (dir: string) => {
    setBusy((b) => (b.includes(dir) ? b : [...b, dir]))
    try {
      const listing = await loadChildren(dir, root, fsList)
      setListings((prev) => ({ ...prev, [dir]: listing }))
      if (dir === root) setError(null)
    } catch (e) {
      if (dir === root) setError(e instanceof Error ? e.message : 'Failed to read directory')
      setListings((prev) => ({ ...prev, [dir]: EMPTY_LISTING }))
    } finally {
      setBusy((b) => b.filter((p) => p !== dir))
    }
  }

  // A new root is a new tree: nothing expanded, nothing previewed.
  useEffect(() => {
    setListings({})
    setExpanded([])
    setSelected(null)
    setError(null)
    if (root) load(root)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  // Refresh after the agent wrote or ran something. codexStore bumps
  // fileTreeVersion on file_change / terminal_output. Reload the root and every
  // open folder, so an expanded subtree stays expanded across a write.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (!root) return
    load(root)
    for (const dir of expanded) load(dir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileTreeVersion])

  const refresh = () => {
    if (!root) return
    load(root)
    for (const dir of expanded) load(dir)
  }

  const onToggleDir = (node: ExplorerNode) => {
    const next = toggleExpanded(expanded, node.path)
    setExpanded(next)
    if (next.includes(node.path) && !listings[node.path]) load(node.path)
  }

  // Native folder picker. Tauri uses the Rust dialog, dev mode a prompt.
  const pickFolder = async () => {
    let picked: string | null = null
    if (isTauri()) {
      try {
        const invoke = (await import('@tauri-apps/api/core')).invoke
        picked = await invoke<string | null>('pick_folder', { defaultPath: root || undefined })
      } catch {
        picked = window.prompt('Enter folder path:', root || (isMacOS() ? '/Users/' : 'C:\\Users'))
      }
    } else {
      picked = window.prompt('Enter folder path:', root || (isMacOS() ? '/Users/' : 'C:\\Users'))
    }
    if (picked) setWorkingDirectory(picked)
  }

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    const onMove = (ev: PointerEvent) => {
      // The panel is on the right, so dragging left makes it wider.
      setExplorerWidth(startWidth + (startX - ev.clientX), window.innerWidth)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  if (collapsed) {
    return (
      <div className="w-7 shrink-0 flex flex-col items-center py-1 border-l border-gray-200 dark:border-white/[0.04] bg-gray-50 dark:bg-white/[0.01]">
        <button
          onClick={() => setExplorerCollapsed(false)}
          title="Show the explorer"
          data-testid="explorer-expand"
          className="p-1 rounded text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
        >
          <PanelRightOpen size={12} />
        </button>
      </div>
    )
  }

  const rootListing = listings[root]
  const rows = flattenTree(root, listings, expanded)
  const loadingRoot = busy.includes(root)

  return (
    <aside
      style={{ width: `${width}px` }}
      className="relative shrink-0 h-full flex flex-col border-l border-gray-200 dark:border-white/[0.04] bg-gray-50 dark:bg-white/[0.01]"
    >
      {/* Drag handle on the panel edge. */}
      <div
        onPointerDown={startDrag}
        title="Drag to resize"
        data-testid="explorer-resize-handle"
        className="absolute left-0 top-0 h-full w-1 -ml-0.5 z-10 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors"
      />

      {/* C2: the plan lives here now, not above the prompt. */}
      <PlanBar variant="panel" />

      <div className="flex items-center gap-1 p-1.5 border-b border-gray-200 dark:border-white/[0.04]">
        <button
          onClick={pickFolder}
          title={root || 'Pick the folder the agent works in'}
          className="flex-1 min-w-0 flex items-center gap-1 px-1.5 py-1 rounded bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 transition-colors text-left"
        >
          <FolderOpen size={10} className="text-gray-500 shrink-0" />
          {root ? (
            <span className="text-[0.5rem] text-gray-700 dark:text-gray-300 font-mono truncate flex-1">{root}</span>
          ) : (
            <span className="text-[0.5rem] text-gray-400 dark:text-gray-600 flex-1">Select folder...</span>
          )}
        </button>
        <button
          onClick={refresh}
          disabled={!root}
          title="Refresh"
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 text-gray-400 dark:text-gray-600 disabled:opacity-30 transition-colors shrink-0"
        >
          <RefreshCw size={10} className={loadingRoot ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={() => setExplorerCollapsed(true)}
          title="Hide the explorer"
          data-testid="explorer-collapse"
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 text-gray-400 dark:text-gray-600 transition-colors shrink-0"
        >
          <PanelRightClose size={12} />
        </button>
      </div>

      <div className={`overflow-y-auto scrollbar-thin p-1 ${selected ? 'max-h-[45%] shrink-0' : 'flex-1 min-h-0'}`}>
        {!root ? (
          <p className="text-[0.5rem] text-gray-400 dark:text-gray-600 px-1 py-2">Click above to set a folder</p>
        ) : error ? (
          <p className="text-[0.5rem] text-red-500/80 px-1 py-2 break-words">{error}</p>
        ) : !rootListing ? (
          <p className="text-[0.5rem] text-gray-400 dark:text-gray-600 px-1 py-2">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-[0.5rem] text-gray-400 dark:text-gray-600 px-1 py-2">Empty directory</p>
        ) : (
          <>
            <ListingHints listing={rootListing} depth={0} />
            {rows.map((row) => {
              const isOpen = row.expanded
              const childListing = listings[row.node.path]
              const isBusy = busy.includes(row.node.path)
              const isSelected = selected?.path === row.node.path
              return (
                <Fragment key={row.node.path}>
                  <button
                    onClick={() =>
                      row.node.isDirectory ? onToggleDir(row.node) : setSelected(row.node)
                    }
                    title={row.node.path}
                    style={{ paddingLeft: `${row.depth * 8 + 4}px` }}
                    className={`flex items-center gap-1 w-full pr-1 py-[2px] text-[0.5rem] rounded transition-colors text-left ${
                      isSelected
                        ? 'bg-blue-500/10 text-gray-800 dark:text-gray-100'
                        : row.node.isDirectory
                          ? 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5'
                          : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5'
                    }`}
                  >
                    {row.node.isDirectory ? (
                      isBusy ? (
                        <Loader2 size={8} className="text-gray-500 shrink-0 animate-spin" />
                      ) : isOpen ? (
                        <ChevronDown size={8} className="text-gray-500 shrink-0" />
                      ) : (
                        <ChevronRight size={8} className="text-gray-500 shrink-0" />
                      )
                    ) : (
                      <span className="w-2 shrink-0" />
                    )}
                    {row.node.isDirectory ? (
                      <Folder size={8} className="text-gray-500 shrink-0" />
                    ) : (
                      <FileText size={8} className="text-gray-400 dark:text-gray-600 shrink-0" />
                    )}
                    <span className="truncate">{row.node.name}</span>
                  </button>
                  {isOpen && childListing && (
                    <ListingHints listing={childListing} depth={row.depth + 1} />
                  )}
                </Fragment>
              )
            })}
          </>
        )}
      </div>

      {selected && (
        // Keyed on the path: another file is another component, so the
        // per-file script opt-in cannot survive the switch.
        <FilePreview key={selected.path} node={selected} root={root} onClose={() => setSelected(null)} />
      )}
    </aside>
  )
}

/** The two things a listing has to admit: the backend cut it off at 500, and
 *  the ignore filter took entries out. Both silently looked like "this is the
 *  whole folder" before. */
function ListingHints({ listing, depth }: { listing: ExplorerListing; depth: number }) {
  if (!listing.truncated && listing.hidden === 0) return null
  return (
    <div style={{ paddingLeft: `${depth * 8 + 4}px` }} className="py-[1px]">
      {listing.truncated && (
        <p className="text-[0.45rem] text-amber-500/80" data-testid="explorer-truncated">
          shortened, first {FS_LIST_CAP} entries only
        </p>
      )}
      {listing.hidden > 0 && (
        <p className="text-[0.45rem] text-gray-400 dark:text-gray-600" title={EXPLORER_IGNORED.join(', ')}>
          {listing.hidden} hidden ({EXPLORER_IGNORED.join(', ')})
        </p>
      )}
    </div>
  )
}
