/**
 * Reasoning that closes a tag it never opened.
 *
 * Ollama's chat templates for the Qwen3 family put the opening `<think>` in the
 * PROMPT. The model therefore never emits one: the wire carries the thought,
 * then `</think>`, then the answer. The char-by-char state machine switches on
 * seeing `<think>`, so it never switches, and with the Thinking toggle ON
 * `finalStripThinkingTags` deliberately leaves canonical markers alone. Result:
 * the raw closer and the entire thought sat in the answer bubble.
 *
 * Captured on the installed 2.6.2 build 2026-08-06, Coding + Ollama + hermes,
 * hf.co/DevQuasar/huihui-ai.Qwen3-4B-abliterated-GGUF, read off the page:
 *
 *   "…without stopping. Let's start with the first step. </think>"
 *
 * David has been describing exactly this: a visible think between the steps
 * that is not rendered as thinking.
 *
 * Run: npx vitest run src/lib/__tests__/orphan-closer.test.ts
 */
import { describe, it, expect } from 'vitest'
import { splitOrphanCloser, splitUnclosedThink } from '../thinking-stripper'

const LIVE = "I should work through the plan without stopping. Let's start with the first step. </think>\n\nStep 1 done."

describe('the shape that was measured', () => {
  it('takes the closer out of the answer', () => {
    expect(splitOrphanCloser(LIVE).content).not.toContain('</think>')
  })

  it('keeps the answer that came after it', () => {
    expect(splitOrphanCloser(LIVE).content.trim()).toBe('Step 1 done.')
  })

  it('routes the thought to the thinking side instead of deleting it', () => {
    const { thinking } = splitOrphanCloser(LIVE)
    expect(thinking).toContain("Let's start with the first step")
    expect(thinking).not.toContain('</think>')
  })
})

describe('NEGATIVE CONTROL: a balanced block is left to the paths that own it', () => {
  it('does nothing when an opener precedes the closer', () => {
    const balanced = '<think>reasoning</think>answer'
    expect(splitOrphanCloser(balanced)).toEqual({ content: balanced, thinking: '' })
  })

  it('does nothing to plain prose', () => {
    const plain = 'Just an answer, no tags at all.'
    expect(splitOrphanCloser(plain)).toEqual({ content: plain, thinking: '' })
  })

  it('does nothing to an empty string', () => {
    expect(splitOrphanCloser('')).toEqual({ content: '', thinking: '' })
  })

  it('leaves an UNCLOSED opener alone, that is the other function', () => {
    const unclosed = 'answer<think>still thinking'
    expect(splitOrphanCloser(unclosed)).toEqual({ content: unclosed, thinking: '' })
    expect(splitUnclosedThink(unclosed).thinking).toBe('still thinking')
  })
})

describe('the two halves compose, in the order the loops call them', () => {
  it('a reply that both starts mid-thought AND is cut off mid-thought', () => {
    // Orphan closer first (it is at the front), unclosed opener second.
    const both = 'opening thought</think>the answer<think>a second thought that never closed'
    const first = splitOrphanCloser(both)
    expect(first.thinking).toBe('opening thought')
    const second = splitUnclosedThink(first.content)
    expect(second.thinking).toBe('a second thought that never closed')
    expect(second.content).toBe('the answer')
  })

  it('the first closer wins when the model emits several', () => {
    // Everything before the FIRST closer is the thought. A later stray closer
    // is content the answer paths strip, not a second block to split on.
    const { content, thinking } = splitOrphanCloser('thought</think>answer</think>tail')
    expect(thinking).toBe('thought')
    expect(content).toBe('answer</think>tail')
  })
})
