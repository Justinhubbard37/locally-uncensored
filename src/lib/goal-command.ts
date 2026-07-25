/**
 * `/goal` handling, shared by Code and Agent so the command behaves identically
 * in both. Kept out of agent-commands.ts, which is pure data by contract.
 *
 * Three shapes:
 *   /goal <text>   set it
 *   /goal          read it back
 *   /goal clear    drop it
 *
 * None of them call a model. Spending a cloud round-trip to have an LLM say
 * "ok, noted" would be theatre, and on a slow local model it would also be the
 * slowest possible way to write one string to a store.
 */

import { useAgentGoalStore, MAX_GOAL_LENGTH } from '../stores/agentGoalStore'

const CLEAR_WORDS = /^(clear|off|none|reset)$/i

export interface GoalCommandResult {
  /** What to show the user in the transcript. */
  message: string
  action: 'set' | 'read' | 'clear' | 'noop'
}

export function applyGoalCommand(conversationId: string, rawArgs: string): GoalCommandResult {
  const store = useAgentGoalStore.getState()
  const args = rawArgs.trim()

  if (!args) {
    const current = store.getGoal(conversationId)
    return current
      ? { action: 'read', message: `Current goal:\n\n${current.text}\n\nUse /goal clear to drop it, or /goal <new objective> to replace it.` }
      : { action: 'read', message: 'No goal set for this session. Use /goal <objective> to set one and it will steer every following turn.' }
  }

  if (CLEAR_WORDS.test(args)) {
    const had = store.getGoal(conversationId)
    if (!had) return { action: 'noop', message: 'There was no goal to clear.' }
    store.clearGoal(conversationId)
    return { action: 'clear', message: 'Goal cleared. Following turns go back to taking each request on its own.' }
  }

  store.setGoal(conversationId, args)
  const saved = store.getGoal(conversationId)
  const truncated = args.length > MAX_GOAL_LENGTH
  return {
    action: 'set',
    message:
      `Goal set:\n\n${saved?.text ?? args}\n\n` +
      (truncated ? `Trimmed to ${MAX_GOAL_LENGTH} characters so it fits in every prompt. ` : '') +
      'Every following turn in this session will see it. /goal clear drops it.',
  }
}
