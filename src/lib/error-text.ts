/**
 * English frames for text we did not write.
 *
 * David, 2026-08-22, from the box: the app showed a failure that was half
 * German. The Rust side is fixed at the source now (src-tauri/src/os_error.rs),
 * so what the backend hands us is English again. This file is about the other
 * half, the text that is not ours to fix.
 *
 * An installer we shell out to answers in the system language. winget on a
 * German Windows prints German, and no amount of care on our side changes
 * that. What we can promise is that the SENTENCE is ours and English, and that
 * the foreign text is labelled as what it is: output from another program,
 * quoted, not spoken by us.
 *
 * The rule this replaces is the one that reads worst in practice: taking the
 * last line of somebody else's log and setting it as the whole error. The user
 * then gets a German fragment with no subject, no context and no clue which
 * program said it.
 */

/** The readable text of anything that was thrown, caught or returned. */
export function detailOf(e: unknown): string {
  if (e == null) return ''
  if (typeof e === 'string') return e.trim()
  if (e instanceof Error) return (e.message || '').trim()
  return String(e).trim()
}

/**
 * Our English sentence, with the foreign text kept underneath it.
 *
 * The detail is never dropped: it is usually the only thing that says which
 * package failed or which port was taken, and support reads it. It is only
 * moved out of the position where it pretended to be our message.
 */
export function withDetail(sentence: string, detail: unknown, label = 'Details'): string {
  const raw = detailOf(detail)
  if (!raw) return sentence
  // Already our own sentence coming back up a call chain: do not frame twice.
  if (raw.startsWith(sentence)) return raw
  return `${sentence}\n\n${label}:\n${raw}`
}

/** The frame for the tail of another program's log. */
export function withInstallerOutput(sentence: string, detail: unknown): string {
  return withDetail(sentence, detail, 'Last output from the installer')
}
