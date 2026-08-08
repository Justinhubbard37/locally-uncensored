// Cut-off notice + empty-answer wording, and the guards that both chat paths
// persist finishReason and the bubble renders the marker (no render harness).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { truncationNotice, emptyAnswerExplanation } from '../answer-notes'

describe('truncationNotice', () => {
  it('flags a length cut and a dropped connection', () => {
    expect(truncationNotice('length')).toBe('Cut off at the length limit')
    expect(truncationNotice('disconnect')).toBe('Connection dropped before the end')
  })

  it('says nothing for a clean stop or an absent reason (negative control)', () => {
    expect(truncationNotice('stop')).toBeNull()
    expect(truncationNotice('tool_calls')).toBeNull()
    expect(truncationNotice(undefined)).toBeNull()
  })
})

describe('emptyAnswerExplanation', () => {
  it('length + reasoning: budget spent thinking', () => {
    expect(emptyAnswerExplanation({ finishReason: 'length', captured: true, keepThinking: true }))
      .toContain('spent its entire token budget thinking')
  })

  it('length + nothing: hit the token limit', () => {
    expect(emptyAnswerExplanation({ finishReason: 'length', captured: false, keepThinking: false }))
      .toContain('hit its token limit')
  })

  it('disconnect wins over the generic note', () => {
    expect(emptyAnswerExplanation({ finishReason: 'disconnect', captured: true, keepThinking: true }))
      .toContain('connection dropped')
  })

  it('clean stop with reasoning: finished thinking, no answer', () => {
    expect(emptyAnswerExplanation({ finishReason: 'stop', captured: true, keepThinking: true }))
      .toContain('finished thinking but never wrote an answer')
  })

  it('clean stop, nothing captured: plain retry note (negative control)', () => {
    expect(emptyAnswerExplanation({ finishReason: 'stop', captured: false, keepThinking: false }))
      .toBe("I didn't return a visible answer that time, please try again.")
  })
})

describe('wiring (source guards)', () => {
  const useChatSrc = readFileSync(join(__dirname, '../../hooks/useChat.ts'), 'utf8')
  const bubbleSrc = readFileSync(join(__dirname, '../../components/chat/MessageBubble.tsx'), 'utf8')

  it('both chat paths persist the finish reason onto the message', () => {
    // single-model path and group path each call the store setter
    const hits = useChatSrc.split('updateMessageFinishReason(').length - 1
    expect(hits).toBeGreaterThanOrEqual(2)
  })

  it('both paths route empty turns through the shared explanation', () => {
    expect(useChatSrc).toContain('emptyAnswerExplanation(')
  })

  it('the bubble renders the cut-off marker from finishReason', () => {
    expect(bubbleSrc).toContain('truncationNotice(message.finishReason)')
  })
})
