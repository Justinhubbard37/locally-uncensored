// "Approve and run" after a Plan-mode run (plan 2.6.6, C1 / blocker S7).
//
// The plan is a function of UNTRUSTED repo content: a README, a file name or an
// AGENTS.md in the workspace can steer what it says. So two things are fixed
// here and are not up for convenience:
//
//   1. The card shows the FULL plan text, the concrete commands and target
//      paths, not the todo titles. The user approves what they can read.
//   2. The execution never lands in Bypass implicitly. The target mode is
//      resolved from the user's own visible choices and printed ON the button,
//      so "Approve and run (Ask)" is a promise about what happens next.

import { useState } from 'react'
import { ClipboardCheck, ChevronDown, X } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useCodexStore } from '../../stores/codexStore'
import { useGenerationStore } from '../../stores/generationStore'
import { resolveApproveTargetMode, CODEX_MODE_SHORT, CODEX_MODE_DESCRIPTIONS } from '../../lib/codex-mode'
import { CODEX_PLAN_APPROVED_INSTRUCTION } from '../../lib/codex-plan-prompt'

export function PlanApprovalBar({ onApprove }: { onApprove: (instruction: string) => void }) {
  const [expanded, setExpanded] = useState(true)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const approval = useCodexStore((s) =>
    activeConversationId ? s.planApprovalByConversation[activeConversationId] : undefined,
  )
  const parked = useCodexStore((s) =>
    activeConversationId ? s.parkedModeByConversation[activeConversationId] : undefined,
  )
  const prePlan = useCodexStore((s) =>
    activeConversationId ? s.prePlanModeByConversation[activeConversationId] : undefined,
  )
  const chooseCodexMode = useCodexStore((s) => s.chooseCodexMode)
  const setPlanApproval = useCodexStore((s) => s.setPlanApproval)
  const generating = useGenerationStore((s) => s.generating)

  if (!activeConversationId || !approval) return null
  // A run is already going: the card would offer a second parallel send.
  if (generating[activeConversationId] === true) return null

  const target = resolveApproveTargetMode({ parked, previous: prePlan })

  const approve = () => {
    // Switch the conversation out of Plan mode FIRST, so the send that follows
    // resolves its knobs under the mode printed on the button.
    chooseCodexMode(activeConversationId, target, false)
    setPlanApproval(activeConversationId, null)
    onApprove(CODEX_PLAN_APPROVED_INSTRUCTION)
  }

  return (
    <div className="w-full max-w-[70%] mx-auto px-3 pb-1">
      <div className="w-full rounded-md border border-purple-500/25 bg-purple-500/[0.04]">
        <div className="flex items-center gap-1.5 px-2 py-1">
          <ClipboardCheck size={9} className="text-purple-400 shrink-0" />
          <span className="text-[0.55rem] uppercase tracking-wider text-gray-500 shrink-0">plan ready</span>
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex-1 min-w-0 flex items-center gap-1 text-left text-[0.55rem] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            <span>{expanded ? 'Hide the full plan' : 'Show the full plan'}</span>
            <ChevronDown size={9} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
          <button
            onClick={approve}
            title={`Runs the plan in ${CODEX_MODE_SHORT[target]} mode. ${CODEX_MODE_DESCRIPTIONS[target]}`}
            className="shrink-0 px-2 py-0.5 rounded text-[0.55rem] font-medium bg-purple-500/15 text-purple-600 dark:text-purple-300 hover:bg-purple-500/25 transition-colors"
          >
            {`Approve and run (${CODEX_MODE_SHORT[target]})`}
          </button>
          <button
            onClick={() => setPlanApproval(activeConversationId, null)}
            title="Dismiss the plan without running it"
            className="flex items-center justify-center w-4 h-4 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors shrink-0"
          >
            <X size={10} />
          </button>
        </div>
        {expanded && (
          <pre className="mx-2 mb-1.5 max-h-56 overflow-auto scrollbar-thin whitespace-pre-wrap break-words rounded bg-black/[0.03] dark:bg-white/[0.03] px-2 py-1.5 text-[0.55rem] leading-relaxed text-gray-700 dark:text-gray-300">
            {approval.planText}
          </pre>
        )}
      </div>
    </div>
  )
}
