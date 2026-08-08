// Currency must not be eaten by KaTeX. MarkdownRenderer feeds MATH_OPTIONS to
// remark-math; here we run the same remark pipeline headless and assert what it
// parses. unified/remark-parse are remark-math's own peer stack (transitive via
// react-markdown); if that ever stops resolving, this test fails loudly, which
// is the point.
import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import { MATH_OPTIONS } from '../markdown-math'

function nodeTypes(md: string, opts: unknown): Set<string> {
  const tree = unified().use(remarkParse).use(remarkMath, opts as never).parse(md)
  const types = new Set<string>()
  ;(function walk(n: { type?: string; children?: unknown[] }) {
    if (n.type) types.add(n.type)
    for (const c of (n.children ?? []) as { type?: string; children?: unknown[] }[]) walk(c)
  })(tree as never)
  return types
}

const CURRENCY = 'Split the $30 bill. Each of the 3 pays $10.'

describe('MATH_OPTIONS (single-dollar off)', () => {
  it('does not turn a dollar amount into inline math', () => {
    expect(nodeTypes(CURRENCY, MATH_OPTIONS).has('inlineMath')).toBe(false)
  })

  it('still parses real block math ($$ on their own lines)', () => {
    expect(nodeTypes('$$\na^2 + b^2 = c^2\n$$', MATH_OPTIONS).has('math')).toBe(true)
  })

  it('still parses double-dollar inline math', () => {
    expect(nodeTypes('the identity $$e^{i\\pi}=-1$$ holds', MATH_OPTIONS).has('inlineMath')).toBe(true)
  })
})

describe('negative control: the default WOULD eat currency', () => {
  it('single-dollar on parses the same text as inline math', () => {
    // remark-math default is singleDollarTextMath: true — exactly the bug.
    expect(nodeTypes(CURRENCY, { singleDollarTextMath: true }).has('inlineMath')).toBe(true)
  })

  it('our option object is what disables it', () => {
    expect(MATH_OPTIONS.singleDollarTextMath).toBe(false)
  })
})
