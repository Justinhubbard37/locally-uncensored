/**
 * Surgical edit primitive — the core of the `file_edit` tool (2.5.9, M1).
 *
 * Replaces exactly ONE unique occurrence of old_string with new_string, or
 * reports why it could not (empty / no-op / not found / not unique). This is
 * the small-model-friendly alternative to full-file rewrites: the model sends
 * only the lines it wants changed, so editing a 2000-line file costs a few
 * tokens instead of regenerating the whole thing (slow, and prone to
 * truncation on local models). Aider / Cline / Cursor all edit this way.
 *
 * Pure + dependency-free so it can be unit-tested and shared between the tool
 * executor (api/mcp/builtin-tools.ts) and the diff event emitter (useCodex.ts).
 */

export type EditFailReason = 'empty_old' | 'noop' | 'not_found' | 'not_unique'

export interface EditOutcome {
  ok: boolean
  /** The updated file content — present only when ok. */
  content?: string
  /** How many times old_string occurred (0, 1, or >1). */
  matches: number
  /** Machine-usable reason when !ok. */
  reason?: EditFailReason
}

/** Count NON-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/**
 * Apply a unique-match replacement. `oldString` must occur exactly once for the
 * edit to succeed — this is what makes surgical edits safe: an ambiguous match
 * is refused rather than silently changing the wrong (or every) occurrence.
 */
export function applyUniqueEdit(content: string, oldString: string, newString: string): EditOutcome {
  if (oldString === '') return { ok: false, matches: 0, reason: 'empty_old' }
  const matches = countOccurrences(content, oldString)
  if (oldString === newString) return { ok: false, matches, reason: 'noop' }
  if (matches === 0) return { ok: false, matches: 0, reason: 'not_found' }
  if (matches > 1) return { ok: false, matches, reason: 'not_unique' }
  // Exactly one occurrence. Use a FUNCTION replacer so `$&`, `$1`, `$$` etc.
  // in newString are inserted literally — a plain-string replacement would
  // interpret them as capture-group references and corrupt the output.
  const updated = content.replace(oldString, () => newString)
  return { ok: true, content: updated, matches: 1 }
}
