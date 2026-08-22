/**
 * Which tool calls do NOT belong in the transcript.
 *
 * Leaf module so the rule is testable without the icon set, framer-motion and
 * the Tauri backend that ToolCallBlock pulls in.
 *
 * David has now said this several times, most recently 2026-08-06: "Du solltest
 * auch die Planbenachrichtigung und den Planfortschritt nicht im Transfer
 * haben."
 *
 * `todo_write` is the agent maintaining its own plan, and the plan already has
 * a home: PlanBar, in the header band on LU and at the bottom of the Explorer
 * column on Code, always current, one glance. Every
 * card the tool ALSO drops into the transcript repeats that list in full.
 * Captured on the installed build during a 30 step run: the plan text was
 * sitting in the transcript between the steps, and on a run that revises its
 * list every step that is thirty copies of the same thing pushing the actual
 * work off screen.
 *
 * Hidden only when it WORKED. A failed, rejected or not-yet-approved call still
 * renders, because then the card is the only place the user could learn that
 * the agent's plan never got written.
 */
export interface TranscriptToolCall {
  toolName: string
  status: string
}

const OWNED_BY_ANOTHER_SURFACE: Record<string, true> = {
  todo_write: true, // PlanBar
}

export function hiddenFromTranscript(toolCall: TranscriptToolCall): boolean {
  if (!OWNED_BY_ANOTHER_SURFACE[toolCall.toolName]) return false
  return toolCall.status === 'completed' || toolCall.status === 'cached' || toolCall.status === 'running'
}
