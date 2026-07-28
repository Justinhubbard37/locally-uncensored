import { describe, it, expect } from 'vitest'
import { summarizeTurn, type TurnToolCall } from '../turn-summary'

// D#81, second half. The first half stopped a failed generation from counting
// as a delivered one. This half is about what the user then reads. The model
// usually says nothing after calling image_generate, so this text IS the reply.

const failedImage = (result: string): TurnToolCall => ({
  toolName: 'image_generate',
  status: 'failed',
  result,
})

describe('summarizeTurn', () => {
  describe('a failed picture', () => {
    it('THE FIX: says what went wrong instead of "Task completed: 1 failed."', () => {
      const text = summarizeTurn({
        calls: [failedImage('Image generation failed: ComfyUI rejected workflow: 400 Bad Request')],
        imageGenDone: 0,
        videoGenDone: 0,
        visionFeedbackGiven: false,
      })
      expect(text).toContain('400 Bad Request')
      expect(text).not.toContain('Task completed')
    })

    it('never calls a turn completed when nothing completed', () => {
      const text = summarizeTurn({
        calls: [failedImage('Error: fetch failed')],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text.toLowerCase()).not.toContain('completed')
    })

    it('tells the user how to retry', () => {
      const text = summarizeTurn({
        calls: [failedImage('Cannot generate: wan2.1 supports at most 81 frames (you requested 200).')],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).toContain('again')
    })

    it('names video when the video tool is the one that failed', () => {
      const text = summarizeTurn({
        calls: [{ toolName: 'video_generate', status: 'failed', result: 'Video generation timed out after 10 minutes.' }],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).toContain('video')
      expect(text).toContain('timed out')
    })

    it('still says something useful when no reason came back', () => {
      const text = summarizeTurn({
        calls: [{ toolName: 'image_generate', status: 'failed', result: '' }],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).toContain('ComfyUI')
      expect(text).not.toContain('undefined')
    })
  })

  describe('a picture that landed', () => {
    it('stays silent unless the model actually saw it', () => {
      const call: TurnToolCall = { toolName: 'image_generate', status: 'completed', result: '/view?filename=a.png' }
      expect(summarizeTurn({ calls: [call], imageGenDone: 1, videoGenDone: 0, visionFeedbackGiven: false })).toBe('')
      expect(summarizeTurn({ calls: [call], imageGenDone: 1, videoGenDone: 0, visionFeedbackGiven: true })).toContain('Bild')
    })

    it('mentions both when an image and a clip landed', () => {
      const text = summarizeTurn({
        calls: [], imageGenDone: 1, videoGenDone: 1, visionFeedbackGiven: true,
      })
      expect(text).toContain('Bild')
      expect(text).toContain('Video')
    })
  })

  describe('ordinary tool turns are unchanged', () => {
    it('counts writes and reads', () => {
      const text = summarizeTurn({
        calls: [
          { toolName: 'file_write', status: 'completed' },
          { toolName: 'file_read', status: 'completed' },
          { toolName: 'file_read', status: 'completed' },
        ],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).toBe('Task completed: 1 file written, 2 files read.')
    })

    it('a partial run says partly done, not completed', () => {
      const text = summarizeTurn({
        calls: [
          { toolName: 'file_write', status: 'completed' },
          { toolName: 'shell_execute', status: 'failed', result: 'Error: exit 1' },
        ],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).toContain('partly done')
      expect(text).toContain('1 step failed')
    })

    it('a non-media failure does not borrow the picture wording', () => {
      const text = summarizeTurn({
        calls: [{ toolName: 'web_search', status: 'failed', result: 'Error: fetch failed' }],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).not.toContain('did not come out')
      expect(text).toContain('1 step failed')
    })

    it('falls back to the rephrase hint when nothing ran at all', () => {
      const text = summarizeTurn({
        calls: [], imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).toContain('rephrase')
    })
  })
})
