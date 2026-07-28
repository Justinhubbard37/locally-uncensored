// The closing line an agent turn shows when the model itself said nothing.
//
// That is not a rare corner: a model very often calls image_generate and stops,
// leaving this function to write the entire visible reply. Which is why the old
// version mattered so much. It counted tool calls into "Task completed: 1
// failed." and dropped the reason on the floor, so a user whose ComfyUI
// returned a 400 saw a green sounding sentence, a block labelled "Failed:
// image_generate", and nothing at all about what went wrong. TheRealNovelist
// read that as the app losing the picture and scrambling the chat (D#81).
//
// Rules encoded here:
//   - a failed picture is never a completed task
//   - when a picture fails, the reason we already have gets shown
//   - a partial run says partial, not completed

import { isMediaTool } from './media-result'

export interface TurnToolCall {
  toolName: string
  status?: string
  result?: string | null
}

export interface TurnSummaryInput {
  calls: TurnToolCall[]
  /** Media that really landed this turn, already validated by the caller. */
  imageGenDone: number
  videoGenDone: number
  /** True only when an image was fed back to a vision-capable model. */
  visionFeedbackGiven: boolean
}

const NOTHING_AT_ALL =
  "I couldn't produce a response for that. Please rephrase, or turn off Think and send again."

/**
 * Returns the text to show, or '' to leave the bubble empty (the tool block
 * already carries the picture, so a robotic "your video is above" only adds
 * noise · David 2026-06-16).
 */
export function summarizeTurn(input: TurnSummaryInput): string {
  const { calls, imageGenDone, videoGenDone, visionFeedbackGiven } = input
  const completed = calls.filter((c) => c.status === 'completed')
  const failed = calls.filter((c) => c.status === 'failed')

  if (imageGenDone > 0 || videoGenDone > 0) {
    if (!visionFeedbackGiven) return ''
    if (imageGenDone > 0 && videoGenDone > 0) {
      return 'Fertig, dein Bild und dein Video sind oben. / Done, your image and video are above.'
    }
    return videoGenDone > 0
      ? 'Fertig, dein Video ist oben. / Done, your video is above.'
      : 'Fertig, dein Bild ist oben. / Done, your image is above.'
  }

  // Nothing landed. If a picture or clip was attempted and failed, that is the
  // headline, and the tool already told us why.
  const failedMedia = failed.filter((c) => isMediaTool(c.toolName))
  if (failedMedia.length) {
    const kind = failedMedia.some((c) => c.toolName === 'video_generate') ? 'video' : 'image'
    const why = (failedMedia[0].result ?? '').trim()
    return why
      ? `That ${kind} did not come out: ${why}\n\nSay "again" to retry, or change the prompt or model and send it once more.`
      : `That ${kind} did not come out and no reason came back. Check that ComfyUI is still running, then try again.`
  }

  const writes = completed.filter((c) => c.toolName === 'file_write').length
  const reads = completed.filter((c) => c.toolName === 'file_read').length
  const otherOk = completed.length - writes - reads
  const parts: string[] = []
  if (writes) parts.push(`${writes} file${writes === 1 ? '' : 's'} written`)
  if (reads) parts.push(`${reads} file${reads === 1 ? '' : 's'} read`)
  if (otherOk) parts.push(`${otherOk} operation${otherOk === 1 ? '' : 's'} completed`)

  const failedNote = `${failed.length} step${failed.length === 1 ? '' : 's'} failed`
  if (parts.length) {
    return failed.length
      ? `Task partly done: ${parts.join(', ')}. ${failedNote}.`
      : `Task completed: ${parts.join(', ')}.`
  }
  return failed.length ? `That did not work out. ${failedNote}, nothing else ran.` : NOTHING_AT_ALL
}
