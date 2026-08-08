/**
 * G22 (R20 witness, 2026-08-07): image_generate SUCCEEDED, the loop attached
 * the picture to the next turn, and the text-only model
 * (mlabonne_gemma-3-4b-it-abliterated on LM Studio) refused it — the run
 * ended two steps before the finish with an app-authored error. The model
 * did everything right; our feedback path assumed vision.
 *
 * The heal strips ONLY the loop's own attachments and lets the turn retry.
 * A user-attached image is deliberately not healed: the user's request
 * depends on it, so the honest error stays the right outcome there.
 *
 * Run: npx vitest run src/lib/__tests__/vision-heal.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { stripVisionFeedbackMessages, VISION_FALLBACK_TEXT, type HealableMessage } from '../vision-heal'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

const IMG = [{ data: 'aGk=', mimeType: 'image/png' }]

function loopAttachment(fallback?: string): HealableMessage {
  return {
    role: 'user',
    content: 'Here is the image you just generated, shown to the user.',
    images: [...IMG],
    visionFeedback: true,
    ...(fallback ? { fallbackText: fallback } : {}),
  }
}

describe('stripVisionFeedbackMessages', () => {
  it('R20 witness: the loop attachment degrades to its text fallback and the caller retries', () => {
    const messages: HealableMessage[] = [
      { role: 'system', content: 'contract' },
      { role: 'user', content: 'make me a picture of a fox' },
      { role: 'tool', content: 'Image generated: fox.png' },
      loopAttachment('The image was generated successfully. If the user asked for a video, call video_generate with inputImage set to "fox.png".'),
    ]
    expect(stripVisionFeedbackMessages(messages)).toBe(true)
    const healed = messages[3]
    expect(healed.images).toBeUndefined()
    expect(healed.visionFeedback).toBeUndefined()
    expect(healed.role).toBe('user')
    expect(healed.content).toContain('fox.png')
  })

  it('falls back to the shared text when the attachment carries none', () => {
    const messages = [loopAttachment()]
    expect(stripVisionFeedbackMessages(messages)).toBe(true)
    expect(messages[0].content).toBe(VISION_FALLBACK_TEXT)
  })

  it('NEGATIVE CONTROL: a user-attached image is not healed and the run may end honestly', () => {
    const messages: HealableMessage[] = [
      { role: 'user', content: 'what is in this picture?', images: [...IMG] },
    ]
    expect(stripVisionFeedbackMessages(messages)).toBe(false)
    expect(messages[0].images).toHaveLength(1)
    expect(messages[0].content).toBe('what is in this picture?')
  })

  it('NEGATIVE CONTROL: a second multimodal error finds nothing left to heal', () => {
    // The retry loop must not spin: heal once, then the error surfaces.
    const messages = [loopAttachment()]
    expect(stripVisionFeedbackMessages(messages)).toBe(true)
    expect(stripVisionFeedbackMessages(messages)).toBe(false)
  })

  it('heals every loop attachment, not just the last one', () => {
    const messages = [loopAttachment(), { role: 'assistant' as const, content: 'looking' }, loopAttachment()]
    expect(stripVisionFeedbackMessages(messages)).toBe(true)
    expect(messages.filter((m) => m.images?.length)).toHaveLength(0)
  })
})

describe('the agent loop actually wires the heal', () => {
  const hook = read('../../hooks/useAgentChat.ts')

  it('both transport branches heal before any other error handling', () => {
    const occurrences = hook.split('stripVisionFeedbackMessages(agentMessages)').length - 1
    expect(occurrences).toBe(2)
  })

  it('a healed run stops attaching for its remainder', () => {
    expect(hook).toContain('if (visionRefused) break')
  })

  it('the attachment itself carries the heal marker and its fallback', () => {
    const vf = read('../../api/vision-feedback.ts')
    expect(vf).toContain('visionFeedback: true')
    expect(vf).toContain('fallbackText:')
  })
})
