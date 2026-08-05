import { useCodex } from '../../hooks/useCodex'
import { useCodexStore } from '../../stores/codexStore'
import { useChatStore } from '../../stores/chatStore'
import { useGenerationStore } from '../../stores/generationStore'
import { ChatInput } from './ChatInput'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolCallBand } from './ToolCallBand'
import { groupAgentBlocks } from '../../lib/tool-call-groups'
import { ThinkingBlock } from './ThinkingBlock'
import { MarkdownRenderer } from './MarkdownRenderer'
import { TokenCounter } from './TokenCounter'
import { ContextDropdown } from './ContextDropdown'
import { SmallModelModeToggle } from './SmallModelModeToggle'
import { RealtimeCounter } from './RealtimeCounter'
import { PluginsDropdown } from './PluginsDropdown'
import { ModelSelector } from '../models/ModelSelector'
import { GoalBar } from './GoalBar'
import { LoopBar } from './LoopBar'
import { TypingIndicator } from './TypingIndicator'
import { useSettingsStore } from '../../stores/settingsStore'
import { useModelStore } from '../../stores/modelStore'
import { StagedChangesPanel } from './StagedChangesPanel'
import { SlashStepsBlock } from './SlashStepsBlock'
import { User, Code, Eye, GitBranch, Download, RefreshCw, RotateCcw, Folder, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { checkGitInstalled, openExternal, type GitStatus } from '../../api/backend'
import { CodexConfirmDialog } from './CodexConfirmDialog'
import { stripModelNoise } from '../../lib/strip-model-noise'

// Code always drives a tool loop, so the aggressive tier applies here.
const stripChannelTags = (text: string) => stripModelNoise(text, { aggressive: true })

// Code-Mode renders EVERY between-tool answer as normal, always-visible prose
// now (David 2026-06-04: "kein Collapse, das soll ganz normal wie eine Antwort
// angezeigt werden"). The render path below dedupes verbatim repeats so a
// chatty small model can't stack the same line. (The old CollapsibleAnswer
// one-line-preview component was removed.)

export function CodexView() {
  const { sendInstruction, stopCodex, isRunning } = useCodex()
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const thread = useCodexStore((s) => activeConversationId ? s.threads[activeConversationId] : undefined)
  const scrollRef = useRef<HTMLDivElement>(null)

  const conversation = conversations.find(c => c.id === activeConversationId)
  const messages = conversation?.messages || []

  // Per-conversation generating flag (David 2026-06-12): the typing indicator
  // + realtime counter + a message's live-stream state must follow the coding
  // chat that's ACTUALLY running — not every chat the user switches to. The
  // hook's `isRunning` is global (kept for the input, which guards shared stream
  // refs); the visual bits below read this conversation-scoped flag instead.
  const generatingMap = useGenerationStore((s) => s.generating)
  const codexGenerating = !!activeConversationId && !!generatingMap[activeConversationId]

  // Smart auto-scroll (David 2026-06-12: "kann nicht scrollen, bin locked, jumpt
  // zurück auf ganz unten"). A scroll listener records whether the user is at the
  // bottom; we only auto-pin when they are — so scrolling UP to read earlier
  // output is never yanked back down, even when a chunky tool-call block streams
  // in. Mirrors the normal chat's useAutoScroll, which already behaves this way.
  const shouldAutoScroll = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      shouldAutoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    if (shouldAutoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, thread?.events])

  const codexReviewMode = useSettingsStore((s) => s.settings.codexReviewMode)
  const userAvatarDataUrl = useSettingsStore((s) => s.settings.userAvatarDataUrl)
  const activeModel = useModelStore((s) => s.activeModel)
  const createConversation = useChatStore((s) => s.createConversation)
  const codexWorkingDir = useCodexStore((s) => s.workingDirectory)

  // Git availability for the Codex view (v2.5.0). Codex shells out to git for
  // git_status/diff/commit/log; if git is missing those tools fail. Probe on
  // open and surface a minimal install banner when it's not on PATH.
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [gitChecking, setGitChecking] = useState(false)
  useEffect(() => {
    let cancelled = false
    setGitChecking(true)
    checkGitInstalled()
      .then((s) => { if (!cancelled) setGitStatus(s) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setGitChecking(false) })
    return () => { cancelled = true }
  }, [])
  const recheckGit = () => {
    setGitChecking(true)
    checkGitInstalled().then(setGitStatus).catch(() => {}).finally(() => setGitChecking(false))
  }

  // New coding session (David 2026-06-04: "start neu" must really start new).
  // Abort any in-flight loop, then create a fresh codex conversation. The
  // working directory persists in codexStore, so the new session keeps the
  // folder; a brand-new conversation means a brand-new thread on next send.
  const startNewSession = () => {
    stopCodex()
    if (activeModel) createConversation(activeModel, '', 'codex')
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Main panel */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Codex header */}
        <div className="flex items-center gap-1.5 px-2 py-0.5 border-b border-gray-200 dark:border-white/[0.04]">
          <Code size={9} className="text-gray-500" />
          <span className="text-[0.55rem] text-gray-600 dark:text-gray-400 font-medium">Coding Agent</span>
          {/* Code-Review Mode badge (B13) — makes it impossible to miss
              that the agent is read-only. The toggle itself lives in
              Settings → Codex Agent; clicking the badge jumps you there
              isn't worth a routing change in v2.5.0. */}
          {codexReviewMode && (
            <span
              className="flex items-center gap-1 px-1.5 py-0 rounded border border-amber-500/30 text-amber-500 text-[0.55rem] bg-amber-500/[0.04]"
              title="Code-Review Mode is active. The coding agent will inspect the codebase but won't write files or run commands. Disable in Settings → Coding Agent."
            >
              <Eye size={9} />
              <span>Review</span>
            </span>
          )}
          {/* Working directory indicator — so the user always sees WHERE the
              agent operates (David 2026-06-04: "ich hab den Ordner angegeben …
              er ist eigentlich in Dokumenten"). Empty = per-chat sandbox under
              ~/agent-workspace, which is also where shell output now lands. */}
          <span
            className="flex items-center gap-1 text-[0.5rem] text-gray-500 dark:text-gray-500 font-mono truncate max-w-[200px]"
            title={codexWorkingDir || 'Sandbox: ~/agent-workspace/<chat>'}
          >
            <Folder size={9} className="shrink-0 opacity-70" />
            <span className="truncate">{codexWorkingDir || 'sandbox · ~/agent-workspace'}</span>
          </span>
          <div className="flex-1" />
          {/* New coding session — aborts any running loop and starts a fresh
              chat/thread (keeps the working directory). David 2026-06-04:
              "start neu" must actually start new. */}
          <button
            onClick={startNewSession}
            title="New coding session (clears the current run, keeps the folder)"
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.55rem] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
          >
            <RotateCcw size={10} />
            <span>New</span>
          </button>
          <TokenCounter />
          <ContextDropdown />
          <SmallModelModeToggle />
        </div>

        {/* Git-missing banner (v2.5.0). Codex shells out to git for
            status/diff/commit/log — without it those tools fail. Minimal,
            dismiss-by-installing: an Install button (opens the platform git
            download page) + a Recheck button for after the install. */}
        {gitStatus && !gitStatus.installed && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/20 bg-amber-500/[0.06]">
            <GitBranch size={12} className="text-amber-500 shrink-0" />
            <span className="text-[0.6rem] text-amber-600 dark:text-amber-400/90 flex-1 leading-tight">
              Git isn't installed. The coding agent needs it for diffs, commits and history.
            </span>
            <button
              onClick={() => openExternal(gitStatus.download_url)}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[0.6rem] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-300 hover:bg-amber-500/25 border border-amber-500/30 transition-colors"
            >
              <Download size={11} /> Install Git
            </button>
            <button
              onClick={recheckGit}
              disabled={gitChecking}
              title="Re-check after installing Git"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.6rem] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={11} className={gitChecking ? 'animate-spin' : ''} />
            </button>
          </div>
        )}

        {/* Stage-and-Approve queue (B10). Renders nothing when there
            are no pending changes for the active chat, so non-stage-mode
            users never see it. */}
        <StagedChangesPanel chatId={activeConversationId} />

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Code size={24} className="text-gray-300 dark:text-gray-700 mb-2" />
              <p className="text-[0.7rem] text-gray-500 font-medium">Coding Agent</p>
              <p className="text-[0.55rem] text-gray-400 dark:text-gray-600 mt-0.5 max-w-[300px]">
                Send a coding instruction. The coding agent will read your codebase, write code, and run commands.
              </p>
              {!thread?.workingDirectory && (
                <p className="text-[0.55rem] text-amber-500/70 mt-2">
                  Set a working directory in the file tree panel →
                </p>
              )}
            </div>
          ) : (
            <div className="py-1">
              {messages.filter(msg => !msg.hidden).map((msg) => {
                // Slash commands: the user typed "/review", but msg.content holds
                // the expanded instruction the model ran on, show displayContent.
                const rawForDisplay = msg.role === 'user' ? (msg.displayContent || msg.content) : msg.content
                const cleanContent = rawForDisplay ? stripChannelTags(rawForDisplay) : ''
                return (
                  <div
                    key={msg.id}
                    className={`flex gap-2 px-3 py-1 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                  >
                    <div className={`w-5 h-5 rounded overflow-hidden flex items-center justify-center shrink-0 ${
                      msg.role === 'user'
                        ? 'bg-gray-100 dark:bg-white/8'
                        : ''
                    }`}>
                      {msg.role === 'user'
                        ? (userAvatarDataUrl
                            ? <img src={userAvatarDataUrl} alt="" className="w-full h-full object-cover" />
                            : <User size={9} className="text-gray-400" />)
                        : <img src="/LU-monogram-bw.png" alt="" className="w-full h-full object-contain dark:invert-0 invert opacity-80" />
                      }
                    </div>
                    <div className="max-w-[85%] space-y-0.5">
                      {/* Thinking */}
                      {msg.role === 'assistant' && msg.thinking && (
                        <ThinkingBlock
                          thinking={msg.thinking}
                          streaming={codexGenerating && msg.id === messages[messages.length - 1]?.id && !cleanContent.trim()}
                        />
                      )}
                      {(() => {
                        const running = codexGenerating && msg.id === messages[messages.length - 1]?.id
                        const hasBlocks = !!(msg.role === 'assistant' && msg.agentBlocks && msg.agentBlocks.length > 0)
                        const stepCount = msg.agentBlocks?.filter((b) => b.phase === 'tool_call' && b.toolCall).length ?? 0
                        const hasAnswerBlock = !!(msg.agentBlocks && msg.agentBlocks.some((b) => b.phase === 'answer' && b.content.trim()))

                        // Reflection blocks (Architect plan, RepoMap context) ,
                        // shown above the tool calls so the user sees what context
                        // primed the editor model before it started fetching tools.
                        const reflection = hasBlocks ? (
                          <div className="space-y-1">
                            {msg.agentBlocks!
                              .filter((b) => b.phase === 'reflection' && b.content)
                              .map((block) => (
                                <div
                                  key={block.id}
                                  className="px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 bg-gray-50/60 dark:bg-white/[0.02] text-[0.7rem] text-gray-700 dark:text-gray-300"
                                >
                                  <MarkdownRenderer content={stripModelNoise(block.content)} />
                                </div>
                              ))}
                          </div>
                        ) : null

                        // Interleaved tool_call + answer blocks (Codex 2026-05) so
                        // commentary sits BETWEEN tool calls, else the legacy
                        // tool-only split. Identical logic to before, just hoisted
                        // into a value so a slash run can wrap it in the window.
                        const transcript = !hasBlocks
                          ? null
                          : hasAnswerBlock
                            ? (() => {
                                // Interleave strictly by timestamp: tool → answer →
                                // tool → tool → answer … in the real order produced
                                // (provider/LLM-agnostic, David 2026-06-02 r2). Drop
                                // answer blocks that strip to empty.
                                const ordered = [...msg.agentBlocks!]
                                  .filter(
                                    (b) =>
                                      (b.phase === 'tool_call' && b.toolCall) ||
                                      (b.phase === 'answer' && stripChannelTags(b.content)),
                                  )
                                  .sort((a, b) => a.timestamp - b.timestamp)
                                // Render EVERY answer normally + visible
                                // (David 2026-06-04: "kein Collapse, ganz
                                // normal wie eine Antwort"). Skip only a
                                // verbatim repeat of the previous answer.
                                const skippedAnswers = new Set<string>()
                                let lastAnswer = ''
                                for (const b of ordered) {
                                  if (b.phase !== 'answer') continue
                                  const a = stripChannelTags(b.content)
                                  if (!a) continue
                                  if (a === lastAnswer) skippedAnswers.add(b.id)
                                  else lastAnswer = a
                                }
                                return (
                                  <div className="space-y-1">
                                    {groupAgentBlocks(ordered).map((group) => {
                                      // Consecutive tool calls render as ONE
                                      // band that morphs from tool to tool and
                                      // collapses to "N steps" when done
                                      // (David 2026-07-31).
                                      if (group.kind === 'tools') {
                                        return <ToolCallBand key={group.blocks[0].id} calls={group.calls} />
                                      }
                                      const block = group.block
                                      if (block.phase === 'answer') {
                                        const answer = stripChannelTags(block.content)
                                        if (!answer || skippedAnswers.has(block.id)) return null
                                        return (
                                          <div key={block.id} className="px-1 py-0.5">
                                            <div className="text-[0.75rem] leading-relaxed">
                                              <MarkdownRenderer content={answer} />
                                            </div>
                                          </div>
                                        )
                                      }
                                      return null
                                    })}
                                  </div>
                                )
                              })()
                            : (
                                <div className="space-y-0">
                                  {(() => {
                                    const calls = msg.agentBlocks!
                                      .filter((b) => b.phase === 'tool_call' && b.toolCall)
                                      .map((b) => b.toolCall!)
                                    return calls.length > 0 ? <ToolCallBand calls={calls} /> : null
                                  })()}
                                </div>
                              )

                        // Text content, user bubble always; assistant only when
                        // there are no per-iteration answer blocks (interleave
                        // already rendered those). Assistant drops the bubble to
                        // match the regular Chat view; user keeps the right anchor.
                        const textContent = cleanContent && (msg.role === 'user' || !hasAnswerBlock) ? (
                          <div className={
                            msg.role === 'user'
                              ? 'rounded-lg px-2.5 py-1.5 bg-gray-100 dark:bg-white/[0.06] border border-gray-200 dark:border-white/[0.08]'
                              : 'px-1 py-0.5'
                          }>
                            <div className="text-[0.75rem] leading-relaxed">
                              {msg.role === 'user' ? (
                                <p className="text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{cleanContent}</p>
                              ) : (
                                <MarkdownRenderer content={cleanContent} />
                              )}
                            </div>
                          </div>
                        ) : null

                        // Slash command (David 2026-06-12): the STEPS (tool calls +
                        // intermediate commentary) go in the collapsible window;
                        // the FINAL answer renders OUTSIDE it, normal + readable ,
                        // "die finale antwort soll nicht im tool call sein, nur die
                        // letzte". Same block shape for Ollama + LM Studio, so this
                        // is backend-agnostic. The final answer = the last 'answer'
                        // block, or msg.content when the model never emitted one.
                        if (msg.role === 'assistant' && msg.slashCommand) {
                          const blocks = msg.agentBlocks || []
                          const answerBlocks = blocks
                            .filter((b) => b.phase === 'answer' && stripChannelTags(b.content))
                            .sort((a, b) => a.timestamp - b.timestamp)
                          const finalAnswerBlock = answerBlocks[answerBlocks.length - 1]
                          const finalAnswerText = finalAnswerBlock
                            ? stripChannelTags(finalAnswerBlock.content)
                            : (!hasAnswerBlock && cleanContent ? cleanContent : '')
                          // Steps = tool calls + every answer EXCEPT the final one.
                          const stepsOrdered = [...blocks]
                            .filter(
                              (b) =>
                                (b.phase === 'tool_call' && b.toolCall) ||
                                (b.phase === 'answer' &&
                                  stripChannelTags(b.content) &&
                                  b.id !== finalAnswerBlock?.id),
                            )
                            .sort((a, b) => a.timestamp - b.timestamp)
                          return (
                            <>
                              {(stepCount > 0 || running) && (
                                <SlashStepsBlock command={msg.slashCommand} stepCount={stepCount} running={running}>
                                  <div className="space-y-1">
                                    {reflection}
                                    <div className="space-y-1">
                                      {stepsOrdered.map((block, idx) => {
                                        if (block.phase === 'tool_call' && block.toolCall) {
                                          return <ToolCallBlock key={block.id} toolCall={block.toolCall} />
                                        }
                                        const answer = stripChannelTags(block.content)
                                        if (!answer) return null
                                        const prev = stepsOrdered
                                          .slice(0, idx)
                                          .reverse()
                                          .find((b) => b.phase === 'answer' && stripChannelTags(b.content))
                                        if (prev && stripChannelTags(prev.content) === answer) return null
                                        return (
                                          <div key={block.id} className="px-1 py-0.5">
                                            <div className="text-[0.75rem] leading-relaxed">
                                              <MarkdownRenderer content={answer} />
                                            </div>
                                          </div>
                                        )
                                      })}
                                    </div>
                                  </div>
                                </SlashStepsBlock>
                              )}
                              {finalAnswerText && (
                                <div className="px-1 py-0.5">
                                  <div className="text-[0.75rem] leading-relaxed">
                                    <MarkdownRenderer content={finalAnswerText} />
                                  </div>
                                </div>
                              )}
                            </>
                          )
                        }

                        return (
                          <>
                            {reflection}
                            {transcript}
                            {textContent}
                          </>
                        )
                      })()}
                    </div>
                  </div>
                )
              })}
              {/* 3-dot indicator while THIS coding chat is mid-loop. Bound to
                  the per-conversation flag so switching to another (idle) chat
                  doesn't show its dots — David 2026-06-12 ("die drei ladepunkte
                  kommen in vorherigen chats auch"). */}
              {/* Shell/code approval, inline in the stream so it reads as the
                  next step of the run instead of covering it (David 2026-07-24:
                  "ich hätte das gerne im chat, wie ein tool call"). Renders
                  nothing while no request is pending. */}
              <CodexConfirmDialog />
              {codexGenerating && (
                <TypingIndicator />
              )}
            </div>
          )}
        </div>

        {/* Realtime counter */}
        <RealtimeCounter isRunning={codexGenerating} />

        {/* One-time "/" hint, directly above the prompt (Code view only). */}

        {/* Input */}
        <ChatInput
          onSend={(content) => sendInstruction(content)}
          onStop={stopCodex}
          isGenerating={isRunning}
          slashCommands
          composerModel={<ModelSelector openUpward surface="code" />}
          composerAbove={<><LoopBar onStop={stopCodex} /><GoalBar /></>}
          composerActions={<PluginsDropdown openUpward />}
        />
      </div>

      {/* Right sidebar: File Tree */}
      <div className="w-48 shrink-0">
        <FileTree />
      </div>
    </div>
  )
}

import { FileTree } from './FileTree'
