/**
 * A4, the image half: old attachments stop riding along.
 *
 * An image is the only thing in a message the token estimator cannot see, and
 * the plain chat plus both agent loops re-sent every one of them on every
 * request forever. Each claim below has its negative control right next to it,
 * because the whole feature is one boolean away from being off and a test that
 * cannot go red proves nothing.
 */

import { describe, it, expect } from 'vitest'
import {
  ageOutImages,
  imageDropNote,
  GENERATED_IMAGE_DROP_NOTE,
  IMAGE_KEEP_RECENT,
} from '../context-images'
import { buildRequestMessages } from '../context-decay'

const PIXELS = 'A'.repeat(40000)

interface Wire {
  role: string
  content: string
  images?: { data: string; mimeType: string }[]
  visionFeedback?: boolean
  tool_call_id?: string
}

/** A chat of `turns` user/assistant pairs, every user turn with a picture. */
function chatWithImages(turns: number): Wire[] {
  const out: Wire[] = [{ role: 'system', content: 'be helpful' }]
  for (let i = 1; i <= turns; i++) {
    out.push({
      role: 'user',
      content: `question ${i}`,
      images: [{ data: PIXELS, mimeType: 'image/png' }],
    })
    out.push({ role: 'assistant', content: `answer ${i}` })
  }
  return out
}

const imagesOn = (msgs: Wire[]) =>
  msgs.filter((m) => Array.isArray(m.images) && m.images.length > 0).map((m) => m.content)

describe('A4: the picture from message 1 is not in the payload at message 20', () => {
  const history = chatWithImages(20)

  it('keeps only the newest user turns, older attachments become a note', () => {
    const aged = ageOutImages(history)
    expect(imagesOn(aged.messages)).toEqual(['question 19', 'question 20'])
    expect(IMAGE_KEEP_RECENT).toBe(2)

    const first = aged.messages.find((m) => m.content.startsWith('question 1\n'))!
    expect(first.images).toBeUndefined()
    expect(first.content).toContain('question 1')
    expect(first.content).toContain(imageDropNote(1))
    expect(aged.strippedImages).toBe(18)
    expect(aged.savedChars).toBe(18 * PIXELS.length)
  })

  it('negative control: with the notaus off every one of the 20 rides along', () => {
    const aged = ageOutImages(history, { enabled: false })
    expect(imagesOn(aged.messages)).toHaveLength(20)
    expect(aged.strippedImages).toBe(0)
    expect(JSON.stringify(aged.messages)).toBe(JSON.stringify(history))
  })

  it('never touches the array it was handed', () => {
    ageOutImages(history)
    expect(imagesOn(history)).toHaveLength(20)
  })
})

describe('A4: the live turn always keeps its picture', () => {
  it('a single attachment on the newest question survives', () => {
    const msgs: Wire[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'what is this', images: [{ data: PIXELS, mimeType: 'image/png' }] },
    ]
    expect(ageOutImages(msgs).strippedImages).toBe(0)
  })

  it('tool traffic on the user role does not push it out (hermes transport)', () => {
    // Every hermes tool result is a `user` message. Counting those as user
    // turns would drop the picture the question is about one step into the run.
    const msgs: Wire[] = [
      { role: 'user', content: 'describe it', images: [{ data: PIXELS, mimeType: 'image/png' }] },
      { role: 'assistant', content: '<tool_call>{"name":"file_read"}</tool_call>' },
      { role: 'user', content: '<tool_response>bytes</tool_response>' },
      { role: 'assistant', content: '<tool_call>{"name":"file_read"}</tool_call>' },
      { role: 'user', content: '<tool_response>more bytes</tool_response>' },
    ]
    expect(ageOutImages(msgs).strippedImages).toBe(0)
  })

  it('negative control: two more real user turns and it does go', () => {
    const msgs: Wire[] = [
      { role: 'user', content: 'describe it', images: [{ data: PIXELS, mimeType: 'image/png' }] },
      { role: 'assistant', content: 'sure' },
      { role: 'user', content: 'and now' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'and now' },
    ]
    expect(ageOutImages(msgs).strippedImages).toBe(1)
  })
})

describe('A4: a picture the run generated itself says so', () => {
  it('vision feedback degrades to its own note, not the user one', () => {
    const msgs: Wire[] = [
      {
        role: 'user',
        content: 'Here is the image you generated.',
        images: [{ data: PIXELS, mimeType: 'image/png' }],
        visionFeedback: true,
      },
      { role: 'assistant', content: 'looks good' },
      { role: 'user', content: 'now the video' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'go' },
    ]
    const aged = ageOutImages(msgs)
    expect(aged.messages[0].images).toBeUndefined()
    expect(aged.messages[0].content).toContain(GENERATED_IMAGE_DROP_NOTE)
    expect(aged.messages[0].content).not.toContain('ask the user to send')
  })
})

describe('A4: the agent and coding loops inherit the rule from the builder', () => {
  // Neither loop is touched: both already build their request through
  // buildRequestMessages, which is where the rule lives.
  const run: Wire[] = [
    { role: 'system', content: 'you are a coding agent' },
    { role: 'user', content: 'look at this screenshot', images: [{ data: PIXELS, mimeType: 'image/png' }] },
    { role: 'assistant', content: '', tool_call_id: undefined },
    { role: 'tool', content: 'file bytes' },
    { role: 'user', content: 'keep going' },
    { role: 'assistant', content: 'working' },
    { role: 'user', content: 'still going' },
  ]

  it('drops the aged attachment and reports what it saved', () => {
    const built = buildRequestMessages(run as never, { budgetTokens: 64000 })
    expect(built.droppedImages).toBe(1)
    expect(built.savedImageChars).toBe(PIXELS.length)
    expect(imagesOn(built.messages as unknown as Wire[])).toHaveLength(0)
  })

  it('negative control: the contextDecay notaus sends the pixels again', () => {
    const built = buildRequestMessages(run as never, { budgetTokens: 64000, enabled: false })
    expect(built.droppedImages).toBe(0)
    expect(imagesOn(built.messages as unknown as Wire[])).toEqual(['look at this screenshot'])
  })

  it('negative control: the image rule alone can be switched off', () => {
    const built = buildRequestMessages(run as never, { budgetTokens: 64000, ageImages: false })
    expect(built.droppedImages).toBe(0)
    expect(imagesOn(built.messages as unknown as Wire[])).toHaveLength(1)
  })
})
