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

/**
 * Line endings, the reason `file_edit` could not touch a Windows file at all.
 *
 * Measured at the wire on the Windows box, 2026-08-15: `file_read` hands the
 * model the raw file, so on Windows it carries CRLF, and the model sends its
 * `old_string` back with plain LF, which is what models emit. A literal search
 * then finds nothing and the user is told the file cannot be edited. Same
 * mismatch as the staged-apply fix, one layer down.
 *
 * So the search runs on one normalized form. The write-back does NOT: this is
 * the surgical tool, so only the matched region is replaced, in the file's own
 * endings, and every byte around it is left exactly as it was.
 */
const toLf = (text: string) => text.replace(/\r\n/g, '\n')

function eolOf(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? '\r\n' : '\n'
}

const withEol = (text: string, eol: '\r\n' | '\n') =>
  eol === '\r\n' ? toLf(text).replace(/\n/g, '\r\n') : toLf(text)

/**
 * Normalize to LF and keep, for every LF position, the index it came from in
 * the original. That is what lets the match be found on the normalized form
 * and the replacement be cut out of the ORIGINAL, so the untouched part of the
 * file never changes shape. The trailing entry is the end marker, so
 * `map[start + needle.length]` is the index just past the match.
 */
function lfWithMap(text: string): { lf: string; map: number[] } {
  let lf = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') {
      lf += '\n'
      map.push(i)
      i++
      continue
    }
    lf += text[i]
    map.push(i)
  }
  map.push(text.length)
  return { lf, map }
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
  const { lf: contentLf, map } = lfWithMap(content)
  const oldLf = toLf(oldString)
  const newLf = toLf(newString)
  const matches = countOccurrences(contentLf, oldLf)
  if (oldLf === newLf) return { ok: false, matches, reason: 'noop' }
  if (matches === 0) return { ok: false, matches: 0, reason: 'not_found' }
  if (matches > 1) return { ok: false, matches, reason: 'not_unique' }
  // Exactly one occurrence. Cut it out of the ORIGINAL by index instead of
  // running a replace over the normalized copy: that keeps every byte outside
  // the match untouched, so a three-line edit stays a three-line diff. Slicing
  // also sidesteps the `$&` / `$1` / `$$` capture-group syntax that a plain
  // string replacement would interpret and corrupt.
  const start = contentLf.indexOf(oldLf)
  const updated =
    content.slice(0, map[start]) +
    withEol(newLf, eolOf(content)) +
    content.slice(map[start + oldLf.length])
  return { ok: true, content: updated, matches: 1 }
}
