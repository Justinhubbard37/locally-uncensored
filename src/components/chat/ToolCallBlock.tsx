import { useState, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Globe, FileText, FileEdit, Terminal, Image, Film, Loader2, Check, X, Clock, AlertCircle, FolderOpen, Cpu, Monitor, GitBranch, GitCompare, GitCommitHorizontal, GitPullRequest, FlaskConical, History, Users, Database, Download } from 'lucide-react'
import type { AgentToolCall } from '../../types/agent-mode'
import { getComfyHost, getComfyPort, downloadComfyFile } from '../../api/backend'
import { useModelPickStore } from '../../stores/modelPickStore'
import { useGenerationStore } from '../../stores/generationStore'
import { ModelPickerCard, ChangeModelInline, pickKindForToolCall } from './ModelPickerCard'
import { DiffView } from './DiffView'
import { requestGenerationCancel } from '../../api/vram-handoff'

// F1 (konata3602 commitment 2026-05-23) + render fix (konata3602 bug 2026-06-07)
// — when image_generate / video_generate / screenshot produce a ComfyUI output,
// the user must SEE the picture, not a path string. The tool result embeds a
// ComfyUI /view URL whose exact form depends on the runtime:
//   - packaged desktop (Tauri):     http://localhost:8188/view?filename=…
//   - custom / remote ComfyUI host: http://<host>:<port>/view?filename=…
//   - browser / dev (Vite proxy):   /comfyui/view?filename=…   ← konata's case
// The original localhost-only regex silently failed on the latter two, so
// konata (running the web build behind the /comfyui proxy) saw the raw
// "/comfyui/view?…" text and NO image. comfyViewUrlFromResult() now accepts any
// of those forms, but ONLY when the URL points at OUR ComfyUI — a relative
// proxy path, a loopback host, or the user-configured comfy host — and carries
// a filename. A third-party URL in a tool result is never auto-loaded (CSP +
// privacy). Exported for unit testing (see __tests__/ToolCallBlock-image.test.ts).
export function comfyViewUrlFromResult(result: string | null | undefined): string | null {
  if (!result) return null
  const m = result.match(/(https?:\/\/[^\s)\]]+\/view\?[^\s)\]]+|\/comfyui\/view\?[^\s)\]]+|\/view\?[^\s)\]]+)/i)
  if (!m) return null
  const url = m[1]
  if (!/[?&]filename=/i.test(url)) return null               // must be a real ComfyUI output view
  if (url.startsWith('/comfyui/view') || url.startsWith('/view?')) return url   // our own proxy path — safe
  try {
    const host = new URL(url).hostname.toLowerCase()
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
    if (loopback || host === getComfyHost().toLowerCase()) return url
  } catch { /* not a parseable absolute URL — fall through to null */ }
  return null
}

// Feature EE (v2.5.0): video_generate can produce .mp4 (VHS_VideoCombine) or
// .webm outputs. We render those in a <video> element instead of an <img>.
// Animated .webp (SaveAnimatedWEBP) animates fine inside <img>, so it stays on
// the image path. The output filename rides in the `filename=` query param of
// the /view URL, so we inspect THAT, not the URL tail (which ends in `&t=…`).
// Exported for unit testing.
export function isInlineVideoUrl(url: string): boolean {
  try {
    const m = /[?&]filename=([^&]+)/i.exec(url)
    const name = m ? decodeURIComponent(m[1]) : url
    return /\.(mp4|webm)$/i.test(name)
  } catch {
    return /\.(mp4|webm)(?=[?&]|$)/i.test(url)
  }
}

// David 2026-06-12 ("alle tools in chat, mit download"): pull the ComfyUI
// filename/subfolder/type back out of a /view URL so the inline image/video
// gets a Download button (downloadComfyFile fetches the real bytes → native
// Save-As in Tauri / anchor download in the browser). Returns null if the URL
// has no filename. Exported for unit testing.
export function comfyViewParams(url: string | null | undefined): { filename: string; subfolder: string; type: string } | null {
  if (!url) return null
  try {
    const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
    const p = new URLSearchParams(q)
    const filename = p.get('filename')
    if (!filename) return null
    return { filename, subfolder: p.get('subfolder') || '', type: p.get('type') || 'output' }
  } catch {
    return null
  }
}

// Mac MLX media (hard rule: local image/video on Mac is MLX, never ComfyUI —
// see api/mcp/builtin-tools.ts's executeImageGenerateMlx / executeVideoGenerateMlx).
// There is no ComfyUI /view route for these, so the result carries a local
// `blob:` (or, defensively, `data:`) URL created in THIS webview session
// instead. Same F1 result shape as the ComfyUI path — `<kind> generated:
// <file> (prompt: "...")\n<url>` — just a different url scheme. Exported for
// unit testing.
export function localMediaUrlFromResult(result: string | null | undefined): string | null {
  if (!result) return null
  const m = result.match(/(blob:[^\s)\]]+|data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[^\s)\]]+)/i)
  return m ? m[1] : null
}

// Pull the "<file>" back out of the "<kind> generated: <file> (prompt: …"
// prefix so the local-media Download button can suggest a real filename
// (blob:/data: URLs carry no filename of their own, unlike a ComfyUI /view
// URL's `filename=` query param). Exported for unit testing.
export function localMediaFilenameFromResult(result: string | null | undefined): string | null {
  if (!result) return null
  const m = result.match(/^(?:Image|Video) generated:\s*(\S+)/)
  return m ? m[1] : null
}

interface Props {
  toolCall: AgentToolCall
  onApprove?: () => void
  onReject?: () => void
}

// Complete over the registry (audit D4): 16 of 29 tools had no entry and fell
// back to the Terminal icon, so a git_commit looked like a shell command and
// a surgical file_edit like a plain write. Every builtin has a face now.
const TOOL_ICONS: Record<string, typeof Search> = {
  web_search: Search,
  web_fetch: Globe,
  file_read: FileText,
  file_write: FileEdit,
  file_edit: FileEdit,
  file_list: FolderOpen,
  file_search: Search,
  code_execute: Terminal,
  shell_execute: Terminal,
  shell_execute_background: History,
  shell_task_status: History,
  shell_task_list: History,
  shell_task_kill: X,
  git_status: GitBranch,
  git_diff: GitCompare,
  git_log: GitBranch,
  git_commit: GitCommitHorizontal,
  git_push: GitBranch,
  gh_pr_create: GitPullRequest,
  pr_resume: GitPullRequest,
  project_init: FolderOpen,
  run_tests: FlaskConical,
  system_info: Cpu,
  process_list: Cpu,
  screenshot: Monitor,
  image_generate: Image,
  video_generate: Film,
  run_workflow: GitBranch,
  delegate_task: Users,
  get_current_time: Clock,
}

const STATUS_ICONS = {
  pending_approval: Clock,
  running: Loader2,
  completed: Check,
  failed: AlertCircle,
  rejected: X,
  // Phase 6 (v2.4.0): cached result from in-turn cache, no re-execution.
  cached: Database,
}

// memo (audit D2): the Codex/Agent transcript re-renders on every streamed
// frame, and each un-memoised block re-rendered with it. Block updates
// replace the toolCall object, so reference equality is the right check.
export const ToolCallBlock = memo(ToolCallBlockImpl)

function ToolCallBlockImpl({ toolCall, onApprove, onReject }: Props) {
  // Default: collapsed (closed)
  const [open, setOpen] = useState(toolCall.status === 'pending_approval')

  const ToolIcon = TOOL_ICONS[toolCall.toolName] || Terminal
  const StatusIcon = STATUS_ICONS[toolCall.status]
  const isRunning = toolCall.status === 'running'
  const isPending = toolCall.status === 'pending_approval'
  const isFailed = toolCall.status === 'failed' || toolCall.status === 'rejected'
  // Real cancel (David 2026-06-16): only image/video generation supports a true
  // abort (ComfyUI /interrupt + loop abort). Local "cancelling" state flips the
  // mini button to a "stopping…" indicator the moment it's clicked.
  const isGenTool = toolCall.toolName === 'image_generate' || toolCall.toolName === 'video_generate'
  const [cancelling, setCancelling] = useState(false)

  // Inline media preview URL (image_generate / video_generate / screenshot).
  // Computed once; rendered ALWAYS-visible below the header (even while the
  // tool block is collapsed) so an auto-approved generation shows its picture
  // without the user having to expand the block — konata's "and no image".
  // Two possible sources: a ComfyUI /view URL (Windows/Linux), or a local
  // blob:/data: URL from the Mac MLX path (executeImageGenerateMlx /
  // executeVideoGenerateMlx in api/mcp/builtin-tools.ts — no ComfyUI /view
  // route exists for those).
  const comfyPreviewUrl = comfyViewUrlFromResult(toolCall.result)
  const localPreviewUrl = comfyPreviewUrl ? null : localMediaUrlFromResult(toolCall.result)
  const previewUrl = comfyPreviewUrl ?? localPreviewUrl

  // Model-Picker (v2.5.3): while a generation tool call is RUNNING and the
  // executor's pre-VRAM-swap gate is waiting, render the picker inside this
  // block. Once a preference is saved (no picker shows), a mini "Change
  // model" line takes its place so the choice stays one click away.
  const pendingPick = useModelPickStore((s) => s.pending)
  const genKind = pickKindForToolCall(toolCall)
  const showPicker = !!genKind && !!pendingPick && pendingPick.kind === genKind && isRunning

  // Proxy-independent loading (konata 2026-06-08). In browser/dev the tool
  // result carries the RELATIVE `/comfyui/view?…` Vite-proxy path, which loads
  // fine under `npm run dev` (verified E2E). But a built frontend served
  // WITHOUT that dev proxy (e.g. `vite preview` or a static host) would 404 the
  // relative path → no image. If the primary src errors, retry with an ABSOLUTE
  // URL straight to the ComfyUI host: <img>/<video> display is not CORS-gated,
  // so it loads with no server-side proxy. Tauri results are already absolute
  // (they never start with '/') and are unaffected.
  const [imgFailed, setImgFailed] = useState(false)
  const effectivePreviewUrl = (() => {
    if (!previewUrl) return null
    // blob:/data: URLs (Mac MLX) are self-contained in this session — the
    // ComfyUI-host retry below only ever applies to a relative /view path.
    if (imgFailed && previewUrl.startsWith('/')) {
      const path = previewUrl.startsWith('/comfyui/') ? previewUrl.slice('/comfyui'.length) : previewUrl
      return `http://${getComfyHost()}:${getComfyPort()}${path}`
    }
    return previewUrl
  })()
  // A blob:/data: URL carries no `filename=` query param for isInlineVideoUrl
  // to key off, so fall back to the tool name — accurate since the MLX video
  // executor never produces an image result and vice versa.
  const isVideoResult = !!localPreviewUrl
    ? toolCall.toolName === 'video_generate'
    : !!effectivePreviewUrl && isInlineVideoUrl(effectivePreviewUrl)

  return (
    <div className="mb-0.5">
      {/* Header line — monochrome, only status icon has subtle color */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 py-0.5 text-left hover:opacity-80 transition-opacity flex-1 min-w-0"
        >
          <ToolIcon size={10} className="text-gray-500 dark:text-gray-500 shrink-0" />
          <span className={`text-[0.65rem] ${isRunning ? 'lu-tool-shimmer' : 'text-gray-600 dark:text-gray-400'}`}>{toolCall.toolName}</span>
          {isRunning && (
            <span className="flex items-center gap-[3px] shrink-0" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="lu-band-dot w-[3px] h-[3px] rounded-full bg-gray-400 dark:bg-gray-500"
                  style={{ animationDelay: `${i * 0.2}s` }}
                />
              ))}
            </span>
          )}
          <StatusIcon size={9} className={`shrink-0 ${
            toolCall.status === 'completed' ? 'text-gray-400 dark:text-gray-500' :
            isFailed ? 'text-red-400/60' :
            isPending ? 'text-amber-400/60' :
            'text-gray-500'
          } ${isRunning ? 'animate-spin' : ''}`} />
          {toolCall.duration != null && (
            <span className="text-[0.5rem] text-gray-500 dark:text-gray-600">
              {toolCall.duration < 1000 ? `${toolCall.duration}ms` : `${(toolCall.duration / 1000).toFixed(1)}s`}
            </span>
          )}
        </button>
        {/* Real abort (David 2026-06-16): stop a running image/video generation.
            Fires ComfyUI /interrupt AND aborts the agent loop so it won't
            auto-start a replacement. VRAM is restored by runHandoff's finally. */}
        {isRunning && isGenTool && (
          cancelling ? (
            <span className="flex items-center gap-1 text-[0.55rem] text-gray-400 dark:text-gray-500 shrink-0 pr-1">
              <Loader2 size={9} className="animate-spin" /> stopping…
            </span>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setCancelling(true)
                requestGenerationCancel()
                const { generating, aborters } = useGenerationStore.getState()
                Object.keys(generating).forEach((cid) => aborters[cid]?.())
              }}
              title="Stop generation"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.55rem] font-medium text-red-700 dark:text-red-300 bg-red-500/10 hover:bg-red-500/15 border border-red-500/20 dark:border-red-500/25 transition-colors shrink-0"
            >
              <X size={10} /> Stop
            </button>
          )
        )}
      </div>

      {/* Model-Picker (v2.5.3) — LU's own pre-VRAM-swap model choice, shown
          while the executor gate awaits the pick. Falls back to the mini
          "Change model" line once a preference is saved. */}
      {showPicker && pendingPick && <ModelPickerCard request={pendingPick} />}
      {!showPicker && genKind && <ChangeModelInline kind={genKind} />}

      {/* Inline media preview — ALWAYS visible for a completed image/video
          generation, even while the tool block stays collapsed. Before the
          konata 2026-06-07 fix this lived inside the collapsed details, so a
          user with auto-approve (block closed) saw "Image generated: …" text
          and no picture. A .mp4/.webm output renders in a <video>; everything
          else — including animated .webp — in an <img>. URL is bounded to OUR
          ComfyUI by comfyViewUrlFromResult (never auto-loads arbitrary URLs). */}
      {previewUrl && effectivePreviewUrl && (
        <div className="pl-5 pt-0.5 space-y-1">
          {isVideoResult ? (
            <video
              src={effectivePreviewUrl}
              controls
              loop
              onError={() => { if (!imgFailed) setImgFailed(true) }}
              className="block max-w-full max-h-[320px] rounded border border-gray-200 dark:border-white/[0.06]"
            />
          ) : (
            <a href={effectivePreviewUrl} target="_blank" rel="noopener noreferrer" className="block">
              <img
                src={effectivePreviewUrl}
                alt="Generated image"
                onError={() => { if (!imgFailed) setImgFailed(true) }}
                className="max-w-full max-h-[320px] rounded border border-gray-200 dark:border-white/[0.06]"
                loading="lazy"
              />
            </a>
          )}
          {/* Download (David 2026-06-12): generated media shows in the chat with
              a Download button, ChatGPT-style — downloadComfyFile pulls the real
              bytes and saves via the native dialog. Mac MLX results have no
              ComfyUI /view route to re-fetch from, so a plain anchor download
              off the blob:/data: URL already in hand does the same job. */}
          {(() => {
            const p = comfyViewParams(effectivePreviewUrl)
            if (p) {
              return (
                <button
                  onClick={() => { void downloadComfyFile(p.filename, p.subfolder, p.type) }}
                  title="Download"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-blue-500/15 text-blue-500 hover:bg-blue-500/25 border border-blue-500/30 transition-colors"
                >
                  <Download size={11} /> Download
                </button>
              )
            }
            if (!localPreviewUrl) return null
            const filename = localMediaFilenameFromResult(toolCall.result) || (isVideoResult ? 'video.mp4' : 'image.png')
            return (
              <a
                href={effectivePreviewUrl}
                download={filename}
                title="Download"
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-blue-500/15 text-blue-500 hover:bg-blue-500/25 border border-blue-500/30 transition-colors"
              >
                <Download size={11} /> Download
              </a>
            )
          })()}
        </div>
      )}

      {/* Expandable details */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="pl-5 pb-1.5 space-y-1">
              {/* Arguments */}
              <pre className="text-[0.55rem] leading-relaxed text-gray-500 dark:text-gray-500 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1 overflow-x-auto scrollbar-thin">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>

              {/* Diff for the write tools (audit D5): a change view where a
                  change happened, not raw result text. */}
              {toolCall.diff && (
                <div className="max-h-[300px] overflow-auto scrollbar-thin">
                  <DiffView diff={toolCall.diff} />
                </div>
              )}

              {/* Result (raw text). The inline media preview now renders
                  always-visible above the collapsible (konata 2026-06-07). */}
              {toolCall.result && !toolCall.diff && (
                <pre className="text-[0.55rem] leading-relaxed text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1 overflow-auto scrollbar-thin max-h-[300px]">
                  {toolCall.result}
                </pre>
              )}

              {/* Error */}
              {toolCall.error && (
                <pre className="text-[0.55rem] leading-relaxed text-gray-500 dark:text-gray-500 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1">
                  {toolCall.error}
                </pre>
              )}

              {/* Approval buttons — subtle green / red as the user
                  asked for ("approve grün, reject rot, sauber, keine
                  Neonfarben"). Sits inline in the pending tool block
                  instead of a popup over the input. Enter / Esc still
                  trigger the head-of-queue approval (handled in
                  ChatView). */}
              {isPending && onApprove && onReject && (
                <div className="flex items-center gap-1.5 pt-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); onApprove() }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-[0.6rem] font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 dark:bg-emerald-500/10 hover:bg-emerald-500/15 dark:hover:bg-emerald-500/15 border border-emerald-500/20 dark:border-emerald-500/25 transition-colors"
                  >
                    <Check size={10} /> Approve
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onReject() }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-[0.6rem] font-medium text-red-700 dark:text-red-300 bg-red-500/10 dark:bg-red-500/10 hover:bg-red-500/15 dark:hover:bg-red-500/15 border border-red-500/20 dark:border-red-500/25 transition-colors"
                  >
                    <X size={10} /> Reject
                  </button>
                  <span className="ml-1 text-[0.5rem] text-gray-400 dark:text-gray-600 font-mono">⏎ / Esc</span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
