// Did an image_generate / video_generate tool call actually produce media?
//
// The media tools never REJECT. Every failure path in vram-handoff.ts returns a
// human-readable string instead of throwing, and tool-registry.execute() turns
// even a real throw into a returned `Error: …` string. So the promise resolves,
// executeParallel records status 'completed', and the chat layer treats a
// ComfyUI 400/500 exactly like a delivered picture:
//
//   - it counts against the per-turn media cap, so the model cannot retry
//   - the block renders "Completed: image_generate" with a check mark
//   - the failure text is written into long-term memory as a 'reference'
//   - the model is told "(The image is now displayed to the user…)"
//
// That last one is the damaging part: the model reads an injected claim that the
// image exists, right next to the error saying it does not, and usually believes
// the injection. TheRealNovelist (D#81, 2026-07-21) saw exactly this — "it bugs
// out and not send an image, and it change the entire context for the chat …
// after image make an 400 or 500 error code".
//
// Deliberately conservative: this returns true only for failure shapes we
// actually emit. Anything unrecognised counts as success, so a media backend
// that returns some other success format is never misread as broken. The
// alternative (require a ComfyUI /view URL as proof) is stricter but would break
// any non-ComfyUI lane the moment one is added.

/** Failure strings produced by the media path. Verified against vram-handoff.ts
 *  (`Cannot generate:`, `… generation failed:`, `… completed but no output
 *  produced.`, `… timed out after N minutes.`) and tool-registry.ts (`Error:`). */
const MEDIA_FAILURE_RE =
  /^\s*(Error:|Cannot generate:)|generation failed:|generation timed out|completed but no output produced/i

/** True when a media tool result is a failure disguised as a completed call. */
export function isMediaFailureResult(result: string | null | undefined): boolean {
  if (!result) return true // no result at all is not a delivered image either
  return MEDIA_FAILURE_RE.test(result)
}

/** True when this tool name is one whose result carries generated media. */
export function isMediaTool(toolName: string): boolean {
  return toolName === 'image_generate' || toolName === 'video_generate'
}

/**
 * Did this tool call really deliver media? Non-media tools are passed through
 * unchanged (their own status is authoritative), so callers can use this as a
 * single gate without special-casing.
 */
export function mediaCallSucceeded(toolName: string, result: string | null | undefined): boolean {
  if (!isMediaTool(toolName)) return true
  return !isMediaFailureResult(result)
}
