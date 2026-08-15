/**
 * `file_edit` could not touch a single Windows file.
 *
 * Measured at the wire on the Windows box, 2026-08-15, with the real coding
 * agent against a real CRLF file: `file_read` handed the model the raw content
 * (6 CRLF, 0 bare LF), the model sent back a multi-line `old_string` with
 * plain LF, twice in a row, and `file_edit` answered "old_string not found"
 * both times. The model said it out loud in its final message: the tool could
 * not match because of the line endings, so it fell back to a shell one-liner.
 * A user on a stricter setup, or a smaller model without that idea, is simply
 * told the file cannot be edited.
 *
 * Models emit LF. That is not a decision anyone made about the file, it is an
 * artefact of the model, exactly as in the staged-apply fix (E14). So the
 * search compares on one normalized form.
 *
 * The write-back is stricter here than in staged-apply, and deliberately so:
 * `file_edit` is the surgical tool. Only the matched region is replaced, in the
 * file's own line endings, and every byte around it stays untouched, so an
 * edit to three lines never shows up as a whole-file rewrite.
 *
 * Run: npx vitest run src/lib/__tests__/surgical-edit-crlf.test.ts
 */
import { describe, it, expect } from 'vitest'
import { applyUniqueEdit } from '../surgical-edit'

const crlf = (lines: string[]) => lines.join('\r\n')
const lf = (lines: string[]) => lines.join('\n')

const FILE = ['import sys', '', 'def greet():', '    print("alpha")', '    print("beta")', '', 'greet()']

describe('file_edit on a CRLF file with an LF search string', () => {
  it('finds a multi-line old_string that arrives with LF', () => {
    // The exact pair measured on the box.
    const r = applyUniqueEdit(
      crlf(FILE),
      lf(['    print("alpha")', '    print("beta")']),
      '    print("gamma")',
    )
    expect(r.ok).toBe(true)
    expect(r.matches).toBe(1)
    expect(r.content).toContain('print("gamma")')
    expect(r.content).not.toContain('alpha')
  })

  it('leaves the rest of the file byte for byte alone', () => {
    const before = crlf(FILE)
    const r = applyUniqueEdit(
      before,
      lf(['    print("alpha")', '    print("beta")']),
      '    print("gamma")',
    )
    expect(r.content).toBe(crlf(['import sys', '', 'def greet():', '    print("gamma")', '', 'greet()']))
    // No LF sneaked in anywhere, and nothing outside the match moved.
    expect(r.content!.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('writes a multi-line new_string in the line endings the file has', () => {
    const r = applyUniqueEdit(
      crlf(FILE),
      lf(['    print("alpha")', '    print("beta")']),
      lf(['    print("one")', '    print("two")']),
    )
    expect(r.ok).toBe(true)
    expect(r.content).toContain('print("one")\r\n    print("two")')
    expect(r.content!.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('leaves an LF file on LF', () => {
    const r = applyUniqueEdit(
      lf(FILE),
      lf(['    print("alpha")', '    print("beta")']),
      lf(['    print("one")', '    print("two")']),
    )
    expect(r.ok).toBe(true)
    expect(r.content).not.toContain('\r')
  })

  it('still counts two CRLF places as two, so an ambiguous edit is refused', () => {
    // Normalizing must not turn "matches twice" into a silent single hit.
    const twice = crlf(['a = 1', 'x()', 'y()', 'b = 2', 'x()', 'y()'])
    const r = applyUniqueEdit(twice, lf(['x()', 'y()']), 'z()')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_unique')
    expect(r.matches).toBe(2)
  })

  it('calls a CRLF old_string against LF-only content a no-op when it is one', () => {
    // The mirror case: the model copied the CRLF text back verbatim. Identical
    // content must not be written as a "change".
    const r = applyUniqueEdit(lf(FILE), crlf(['    print("alpha")']), lf(['    print("alpha")']))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('noop')
  })

  it('still reports a genuinely missing string as not_found', () => {
    const r = applyUniqueEdit(crlf(FILE), lf(['    print("nope")', '    print("gone")']), 'x')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_found')
    expect(r.matches).toBe(0)
  })
})
