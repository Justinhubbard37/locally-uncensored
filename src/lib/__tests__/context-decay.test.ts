/**
 * A1: age decay for tool results (2.6.6 plan).
 *
 * The claim under test: a long run stops paying for every file it ever read,
 * WITHOUT the model ever editing against content it can no longer see. That
 * second half is the part the Morgan incident and the 80-character-stub loop
 * were made of, so the newest iteration staying byte-for-byte intact gets as
 * many assertions as the saving does.
 */

import { describe, it, expect } from 'vitest'
import {
  applyToolResultDecay,
  buildRequestMessages,
  decayRestoredToolResult,
  pairToolCalls,
  restoreBudgetFor,
  DECAY_RESULT_CHARS,
  RESTORE_RESULT_CHARS,
  type DecayMessage,
} from '../context-decay'

/** A result big enough to matter, unique per label so bytes are comparable. */
function bigResult(label: string, chars = 50000): string {
  const body = `${label} `.repeat(Math.ceil(chars / (label.length + 1)))
  return body.slice(0, chars)
}

/**
 * An OpenAI-shaped coding history: one user instruction, then `steps` rounds of
 * "assistant asks for one tool, tool answers".
 */
function historyOf(steps: Array<{ name: string; args: Record<string, unknown>; result: string }>): DecayMessage[] {
  const out: DecayMessage[] = [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'do the thing' },
  ]
  steps.forEach((s, i) => {
    out.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `call-${i}`, function: { name: s.name, arguments: s.args } }],
    })
    out.push({ role: 'tool', content: s.result, tool_call_id: `call-${i}` })
  })
  return out
}

function readStep(n: number, chars = 50000) {
  return {
    name: 'file_read',
    args: { path: `src/file${n}.ts` },
    result: bigResult(`FILE${n}`, chars),
  }
}

describe('A1: the newest iteration is never touched', () => {
  it('keeps the result of the iteration that just ran byte-for-byte', () => {
    const history = historyOf([readStep(1), readStep(2), readStep(3)])
    const out = applyToolResultDecay(history)
    // Newest result is the last message.
    expect(out.messages[out.messages.length - 1].content).toBe(history[history.length - 1].content)
    expect(String(out.messages[out.messages.length - 1].content)).toHaveLength(50000)
  })

  it('caps the result from step n-3 when step n is built', () => {
    // Four rounds done, so the request under construction is step 5 and the
    // result of step 2 is exactly n-3.
    const history = historyOf([readStep(1), readStep(2), readStep(3), readStep(4)])
    const out = applyToolResultDecay(history)
    const stepTwoResult = String(out.messages[5].content)
    expect(stepTwoResult.length).toBeLessThanOrEqual(DECAY_RESULT_CHARS + 80)
    expect(stepTwoResult).toContain('truncated')
    // And it is still the RIGHT file, head and tail preserved.
    expect(stepTwoResult.startsWith('FILE2')).toBe(true)
  })

  it('reports what it saved so the audit trail can show it', () => {
    const history = historyOf([readStep(1), readStep(2), readStep(3)])
    const out = applyToolResultDecay(history)
    expect(out.trimmedCount).toBe(2)
    expect(out.savedChars).toBeGreaterThan(80000)
  })

  it('leaves a short result alone even when it is old', () => {
    const history = historyOf([
      { name: 'file_read', args: { path: 'a' }, result: 'tiny' },
      readStep(2),
      readStep(3),
    ])
    const out = applyToolResultDecay(history)
    expect(out.messages[3].content).toBe('tiny')
  })
})

describe('A1: decay happens in the builder, never in the store', () => {
  it('does not mutate the array it was given', () => {
    const history = historyOf([readStep(1), readStep(2), readStep(3)])
    const before = history.map((m) => m.content)
    applyToolResultDecay(history)
    expect(history.map((m) => m.content)).toEqual(before)
    expect(String(history[3].content)).toHaveLength(50000)
  })

  it('does not mutate the message objects either', () => {
    const history = historyOf([readStep(1), readStep(2), readStep(3)])
    const original = history[3]
    const out = applyToolResultDecay(history)
    expect(out.messages[3]).not.toBe(original)
    expect(String(original.content)).toHaveLength(50000)
  })
})

describe('A1: the contextDecay notaus', () => {
  it('sends the history unchanged when decay is off (negative control)', () => {
    const history = historyOf([readStep(1), readStep(2), readStep(3)])
    const out = applyToolResultDecay(history, { enabled: false })
    expect(out.trimmedCount).toBe(0)
    expect(out.savedChars).toBe(0)
    expect(out.messages.map((m) => m.content)).toEqual(history.map((m) => m.content))
  })
})

describe('A1: determinism and prefix stability', () => {
  it('produces identical bytes for identical input', () => {
    const history = historyOf([readStep(1), readStep(2), readStep(3)])
    const a = applyToolResultDecay(history)
    const b = applyToolResultDecay(history)
    expect(a.messages.map((m) => m.content)).toEqual(b.messages.map((m) => m.content))
  })

  it('changes exactly ONE place per step: the result that just aged out', () => {
    const four = historyOf([readStep(1), readStep(2), readStep(3), readStep(4)])
    const five = [...four, ...historyOf([readStep(5)]).slice(2)]

    const atFour = applyToolResultDecay(four).messages
    const atFive = applyToolResultDecay(five).messages

    // Everything the earlier step already sent is byte-identical.
    const differing: number[] = []
    for (let i = 0; i < atFour.length; i++) {
      if (atFour[i].content !== atFive[i].content) differing.push(i)
    }
    // Index 9 is step 4's result, the one that just crossed the age line.
    expect(differing).toEqual([9])
  })

  it('never re-cuts a result that was already capped', () => {
    const four = historyOf([readStep(1), readStep(2), readStep(3), readStep(4)])
    const five = [...four, ...historyOf([readStep(5)]).slice(2)]
    const atFour = applyToolResultDecay(four).messages
    const atFive = applyToolResultDecay(five).messages
    // Step 2's result was capped at step 5 already and is untouched at step 6.
    expect(atFive[5].content).toBe(atFour[5].content)
  })
})

describe('A1: session restore keeps the bytes the run already sent', () => {
  it('hands a result the run capped exactly the same 4k bytes', () => {
    const full = bigResult('OLD', 50000)
    const inRun = applyToolResultDecay(
      historyOf([
        { name: 'file_read', args: { path: 'x' }, result: full },
        readStep(2),
        readStep(3),
      ]),
    ).messages[3].content
    expect(decayRestoredToolResult(full)).toBe(inRun)
  })

  it('uses the tight restore budget only for results the run never capped', () => {
    const short = bigResult('SHORT', 3000)
    expect(restoreBudgetFor(short.length)).toBe(RESTORE_RESULT_CHARS)
    const restored = decayRestoredToolResult(short)
    expect(restored.length).toBeLessThanOrEqual(RESTORE_RESULT_CHARS + 80)
    expect(restored).toContain('truncated')
  })

  it('leaves a genuinely small result whole', () => {
    expect(decayRestoredToolResult('three lines of output')).toBe('three lines of output')
  })

  it('is idempotent, so a second restore cannot shrink it again', () => {
    const once = decayRestoredToolResult(bigResult('OLD', 50000))
    expect(decayRestoredToolResult(once)).toBe(once)
  })
})

describe('A1: the trimmed reads are reported back for the loop guard', () => {
  it('names the key of every read it sent capped, and no others', () => {
    const history = historyOf([readStep(1), readStep(2), readStep(3)])
    // Only the results carry a key, exactly as the loops register them.
    const keys = new Map<unknown, string>()
    keys.set(history[3], 'file_read|{"path":"src/file1.ts"}')
    keys.set(history[5], 'file_read|{"path":"src/file2.ts"}')
    keys.set(history[7], 'file_read|{"path":"src/file3.ts"}')
    const out = applyToolResultDecay(history, { keyOf: (m) => keys.get(m) })
    expect(out.trimmedKeys).toEqual([
      'file_read|{"path":"src/file1.ts"}',
      'file_read|{"path":"src/file2.ts"}',
    ])
  })

  it('reports nothing when the result was short enough to survive whole', () => {
    const history = historyOf([
      { name: 'file_read', args: { path: 'a' }, result: 'tiny' },
      readStep(2),
      readStep(3),
    ])
    const keys = new Map<unknown, string>([[history[3], 'file_read|{"path":"a"}']])
    const out = applyToolResultDecay(history, { keyOf: (m) => keys.get(m) })
    expect(out.trimmedKeys).not.toContain('file_read|{"path":"a"}')
  })
})

describe('A1: both transports, not just the OpenAI one', () => {
  it('caps a Hermes tool_response carried on a user message', () => {
    const history: DecayMessage[] = [
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '<tool_call>\n{"name": "file_read", "arguments": {"path":"a"}}\n</tool_call>' },
      { role: 'user', content: `<tool_response>\n${bigResult('HERMES', 40000)}\n</tool_response>` },
      { role: 'assistant', content: '<tool_call>\n{"name": "file_list", "arguments": {"path":"."}}\n</tool_call>' },
      { role: 'user', content: '<tool_response>\nlisting\n</tool_response>' },
    ]
    const out = applyToolResultDecay(history)
    expect(out.trimmedCount).toBe(1)
    expect(String(out.messages[3].content).length).toBeLessThanOrEqual(DECAY_RESULT_CHARS + 80)
    expect(out.messages[5].content).toBe(history[5].content)
  })

  it('pairs id-less native results by order', () => {
    const history: DecayMessage[] = [
      { role: 'assistant', content: '', tool_calls: [
        { function: { name: 'file_read', arguments: { path: 'a' } } },
        { function: { name: 'file_list', arguments: { path: '.' } } },
      ] },
      { role: 'tool', content: 'A' },
      { role: 'tool', content: 'B' },
    ]
    const pairs = pairToolCalls(history)
    expect(pairs.map((p) => [p.name, p.resultIndex])).toEqual([
      ['file_read', 1],
      ['file_list', 2],
    ])
  })
})

describe('A1: the whole builder, in the binding order', () => {
  it('decays first, so the budget counts the SHORT results', () => {
    // Three 50k results are ~37k tokens raw. A 20k budget would drop messages
    // outright if the budget ran first; with decay first everything fits.
    const history = historyOf([readStep(1), readStep(2), readStep(3)])
    const built = buildRequestMessages(history, { budgetTokens: 20000 })
    expect(built.messages).toHaveLength(history.length)
    expect(built.trimmedCount).toBe(2)
    expect(built.promptTokens).toBeLessThan(20000)
  })

  it('reports the size of the request it actually built', () => {
    const history = historyOf([readStep(1), readStep(2), readStep(3)])
    const built = buildRequestMessages(history, { budgetTokens: 64000 })
    const chars = built.messages.reduce((n, m) => n + String(m.content ?? '').length, 0)
    expect(built.promptTokens).toBeGreaterThan(chars / 5)
    expect(built.promptTokens).toBeLessThan(chars)
  })

  it('with decay off the same history is far more expensive (negative control)', () => {
    const history = historyOf([readStep(1), readStep(2), readStep(3)])
    const on = buildRequestMessages(history, { budgetTokens: 64000 })
    const off = buildRequestMessages(history, { budgetTokens: 64000, enabled: false })
    expect(off.promptTokens).toBeGreaterThan(on.promptTokens * 2)
  })
})
