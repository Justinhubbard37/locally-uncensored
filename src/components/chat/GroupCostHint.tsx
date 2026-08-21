// What a group round costs, said out loud above the composer (2.6.6, plan A4).
//
// The group is the only surface where one Enter buys more than one answer, and
// nothing on screen said so: the user picks three models in the Plugins
// dropdown, types a question, and the app quietly bills three completions on
// the shared history. A per-model send budget takes the runaway growth out of
// it, but the multiplier itself is the feature, not a bug, so the honest fix is
// to name it where the user is about to press send.
//
// Only rendered when a line-up is actually active, and never in a single-model
// chat, where it would be noise.

import { Users } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { isGroupChat } from '../../lib/group-chat'

/** The line itself. Kept pure so the wording is testable without a renderer. */
export function groupCostHintText(models: number): string {
  return `1 round = ${models} answers = ${models}x the cost`
}

export function GroupCostHint() {
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const groupModels = useChatStore((s) =>
    activeConversationId
      ? s.conversations.find((c) => c.id === activeConversationId)?.groupModels
      : undefined,
  )

  if (!isGroupChat(groupModels)) return null

  return (
    <div className="w-full max-w-[70%] mx-auto px-3 pb-1 flex justify-center">
      <div className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md border border-amber-500/20 bg-amber-500/[0.04]">
        <Users size={9} className="text-amber-400 shrink-0" />
        <span className="text-[0.55rem] uppercase tracking-wider text-gray-500 shrink-0">group</span>
        <span
          className="flex-1 min-w-0 truncate text-[0.6rem] text-gray-700 dark:text-gray-300"
          title={groupModels.join(', ')}
        >
          {groupCostHintText(groupModels.length)}
        </span>
      </div>
    </div>
  )
}
