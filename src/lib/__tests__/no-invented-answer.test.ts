/**
 * The answer bubble carries the MODEL'S words or nothing.
 *
 * David, 2026-08-07, reading "Done: 3 file(s) written, 20 other operation(s)
 * completed." on the running build: "Das ist ja keine LLM Antwort. Ich moechte
 * nur die LLM Antwort am Ende sehen, Bro. Kein generischer Text von uns."
 * And on the cloud side, after a reasoning-only round: "dann stand da, ja, die
 * KI hat weitergemacht, ohne eine Antwort zu produzieren."
 *
 * Two layers wrote answers for the model:
 *  - useCodex.ts built prose out of tool counters whenever the final turn came
 *    back empty (G14-2). Seen live on R31, stacked on top of the model's own
 *    false completion claim, two layers asserting success for an unfinished run.
 *  - MessageBubble.tsx printed "The model only produced internal reasoning and
 *    no answer" under a reasoning-only reply (G14-3), which additionally told
 *    the USER to rephrase when the correct action was the LOOP continuing (G17).
 *
 * These are source assertions on purpose: the strings ARE the defect, and the
 * fix is their absence. A behavioural harness around the full useCodex hook
 * would drag the whole provider stack into a unit test for a claim a grep
 * states exactly.
 *
 * Run: npx vitest run src/lib/__tests__/no-invented-answer.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const codex = readFileSync(resolve(here, '../../hooks/useCodex.ts'), 'utf8')
const bubble = readFileSync(resolve(here, '../../components/chat/MessageBubble.tsx'), 'utf8')

describe('G14-2: useCodex no longer writes the answer for the model', () => {
  it.each([
    'file(s) written',
    'other operation(s) completed',
    'I stopped without completing the task',
    'I looked (',
    'but the model ended without writing the answer',
    "I couldn't complete the task",
    'Partially done:',
  ])('the tally prose is gone: %s', (needle) => {
    expect(codex).not.toContain(needle)
  })

  it('an empty final turn leaves the content empty instead of substituting', () => {
    // The whole fallback hinged on this guard; with the block gone the guard
    // must be gone too, not repurposed around new substitute text.
    expect(codex).not.toMatch(/if \(!fullContent\.trim\(\)\)/)
  })

  it('the read-only nudge survives: it asks for the ANSWER, not another tool call', () => {
    // Moved here from the retired useCodex-fallback-answer.test.ts, which
    // guarded the deleted tally builder. The nudge is a steer INTO the model,
    // not text we put in its mouth, so it stays.
    expect(codex).toContain('You have read enough. Write the answer now')
  })
})

describe('G14-3: MessageBubble no longer explains a reasoning-only reply', () => {
  it('the stand-in sentence is gone', () => {
    expect(bubble).not.toContain('The model only produced internal reasoning and no answer')
  })

  it('and it does not tell the user to rephrase for the model', () => {
    expect(bubble).not.toContain('rephrase and try again')
  })
})

describe('NEGATIVE CONTROL: labelled app surfaces survive', () => {
  it('the Enable Agent hint card stays, it is an action, not an answer', () => {
    expect(bubble).toContain('Enable Agent')
    expect(bubble).toContain('but Agent Mode is off')
  })

  it('the halt notice in useCodex stays, it is loop status in italics, not an answer', () => {
    expect(codex).toContain('The model is looping')
  })

  it('the auto-apply receipt stays, it reports OUR action, not the model’s words', () => {
    expect(codex).toContain('auto-applied')
  })
})

// G27 wiring: the closing summary must be able to see the plan, otherwise the
// fix in turn-summary can never fire in the real app (R01b, Mac 2026-08-07).
describe('the Agent loop feeds the plan into its closing summary (G27)', () => {
  it('summarizeTurn is called with the live todo state', () => {
    const agentSrc = readFileSync(resolve(here, '../../hooks/useAgentChat.ts'), 'utf8')
    const call = agentSrc.slice(agentSrc.indexOf('summarizeTurn({'))
    expect(call.slice(0, 1000)).toContain('planGap: openPlanGap(useTodoStore.getState().getTodos(convId!))')
  })
})
