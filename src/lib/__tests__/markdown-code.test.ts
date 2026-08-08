/**
 * A streaming code block must never print the word "undefined".
 *
 * Captured on the installed 2.6.2 Windows build, 2026-08-06, during a Coding
 * run on the Ollama transport. The model opened a ```json fence and the
 * transcript rendered, for over three minutes:
 *
 *     json
 *     Copy
 *     undefined
 *
 * Read straight off the page over CDP: two <pre> elements, innerText
 * "json\nCopy\nundefined" and "undefined". The cause was `String(children)` in
 * MarkdownRenderer, and react-markdown passes `children: undefined` for a fence
 * with no content yet.
 *
 * This is not an edge case that needs a broken model to reach. Every code block
 * any model streams passes through the empty state on its way to the first
 * character.
 *
 * Run: npx vitest run src/lib/__tests__/markdown-code.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { codeBlockText } from '../markdown-code'

describe('the empty fence that started this', () => {
  it('renders nothing for the shape react-markdown actually sends', () => {
    expect(codeBlockText(undefined)).toBe('')
  })

  it('renders nothing for null', () => {
    expect(codeBlockText(null)).toBe('')
  })

  it('never produces the literal word', () => {
    for (const empty of [undefined, null, '', []]) {
      expect(codeBlockText(empty)).not.toContain('undefined')
    }
  })
})

describe('NEGATIVE CONTROL: real content is untouched', () => {
  it('keeps a normal block exactly as it was', () => {
    expect(codeBlockText('const a = 1\nconst b = 2')).toBe('const a = 1\nconst b = 2')
  })

  it('strips the fence its own trailing newline, and only one', () => {
    expect(codeBlockText('line\n')).toBe('line')
    expect(codeBlockText('line\n\n')).toBe('line\n')
  })

  it('joins the array form react-markdown uses for multi-part children', () => {
    expect(codeBlockText(['const a', ' = 1'])).toBe('const a = 1')
  })

  it('does not swallow content that merely LOOKS empty', () => {
    // A block of whitespace is content the user wrote. Only null/undefined is
    // the absent case.
    expect(codeBlockText('   ')).toBe('   ')
    expect(codeBlockText('0')).toBe('0')
  })

  it('keeps a block whose text genuinely contains the word', () => {
    expect(codeBlockText('let x = undefined')).toBe('let x = undefined')
  })
})

describe('the renderer asks instead of stringifying', () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../components/chat/MarkdownRenderer.tsx'),
    'utf8',
  )

  it('calls the helper', () => {
    expect(src).toMatch(/code=\{codeBlockText\(children\)\}/)
  })

  it('the raw String(children) is gone', () => {
    expect(src).not.toMatch(/String\(children\)/)
  })
})
