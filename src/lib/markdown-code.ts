/**
 * What a fenced code block actually renders as text.
 *
 * Leaf module so it can be tested without pulling react-markdown and the katex
 * stylesheet into a `node` test environment.
 *
 * The reason it exists: react-markdown hands the `code` component
 * `children: undefined` for a fence with nothing inside it, and the renderer
 * used to do `String(children)`, which is the string "undefined". A user sees
 * the word printed in a code box.
 *
 * That is not a rare shape. It is EVERY streamed code block, for as long as it
 * takes the opening fence to be followed by a first character. Measured on the
 * installed build 2026-08-06 during a Coding run: the model opened a ```json
 * fence, and the transcript showed
 *
 *     json
 *     Copy
 *     undefined
 *
 * for over three minutes while the rest of the answer was still arriving.
 */
export function codeBlockText(children: unknown): string {
  if (children == null) return ''
  const text = Array.isArray(children) ? children.join('') : String(children)
  // One trailing newline is the fence's own, not content.
  return text.replace(/\n$/, '')
}
