import { describe, it, expect } from 'vitest'
import { comfyStartupError } from '../comfyError'

// GH #98: "did not come up" used to be a dead end. The error must carry the
// crash tail when there is one, and stay the old pointer when there is not.
describe('comfyStartupError', () => {
  it('falls back to the settings pointer without output', () => {
    expect(comfyStartupError()).toContain('Check Settings')
    expect(comfyStartupError([])).toContain('Check Settings')
    expect(comfyStartupError(['  ', ''])).toContain('Check Settings')
  })

  it('carries the last meaningful lines of a crash', () => {
    const lines = [
      '[start] python main.py --port 8188',
      'Traceback (most recent call last):',
      '  File "main.py", line 1, in <module>',
      "ModuleNotFoundError: No module named 'torch'",
    ]
    const msg = comfyStartupError(lines)
    expect(msg).toContain('did not come up')
    expect(msg).toContain("ModuleNotFoundError: No module named 'torch'")
  })

  it('keeps only the tail of a long log', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`)
    const msg = comfyStartupError(lines)
    expect(msg).toContain('line 49')
    expect(msg).not.toContain('line 40\n')
  })
})
