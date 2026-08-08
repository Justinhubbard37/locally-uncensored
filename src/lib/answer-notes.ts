// One source of truth for what the UI says when an assistant turn did NOT end
// on the model's own terms. Both the single-model path and the group path go
// through here so the wording never drifts (David 2026-08-08: a length-cut in a
// group turn used to show a generic "didn't return a visible answer", with no
// hint that the token budget ran out; and a cut answer carried no marker at all,
// while the benchmark screen has always flagged cut-offs).

/** Short badge label for a turn the model did not finish on its own terms.
 *  null for a clean stop, so the caller renders nothing. */
export function truncationNotice(finishReason?: string): string | null {
  if (finishReason === 'length') return 'Cut off at the length limit'
  if (finishReason === 'disconnect') return 'Connection dropped before the end'
  return null
}

/** Explanation to place in an assistant bubble that produced no visible answer.
 *  `captured` = some reasoning was kept; `keepThinking` = Thinking is on. */
export function emptyAnswerExplanation(opts: {
  finishReason?: string
  captured: boolean
  keepThinking: boolean
}): string {
  const { finishReason, captured, keepThinking } = opts
  if (finishReason === 'length') {
    return captured
      ? 'The model spent its entire token budget thinking and never wrote the answer. Try again, reasoning is not deterministic, or turn Thinking off for this question.'
      : 'The model hit its token limit before writing an answer. Try again, or raise Max Tokens in Settings.'
  }
  if (finishReason === 'disconnect') {
    return 'The connection dropped before the model finished its answer. Check your network and try again.'
  }
  return captured && keepThinking
    ? 'The model finished thinking but never wrote an answer. Try again, or turn Thinking off for this question.'
    : "I didn't return a visible answer that time, please try again."
}
