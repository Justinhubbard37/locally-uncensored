import { describe, it, expect } from 'vitest'
import { stripModelNoise } from '../strip-model-noise'

describe('stripModelNoise', () => {
  it('drops the truncated ool_call> line David saw twice', () => {
    const wire = 'Here is the answer.\nool_call>\nMore prose.'
    expect(stripModelNoise(wire)).toBe('Here is the answer.\n\nMore prose.')
  })

  it('drops a LOOP_DONE line with its trailing reason', () => {
    const answer = 'README.md now documents greet.\nLOOP_DONE (verified by reading the file)'
    expect(stripModelNoise(answer)).toBe('README.md now documents greet.')
  })

  it('drops LOOP_CONTINUE too', () => {
    expect(stripModelNoise('Still working.\nLOOP_CONTINUE')).toBe('Still working.')
  })

  it('strips channel and ChatML tokens', () => {
    expect(stripModelNoise('<|channel|>answer<|im_end|>')).toBe('answer')
  })

  it('strips hallucinated hermes tags with their content', () => {
    const t = 'Reply.<tool_response>Error: nope</tool_response>'
    expect(stripModelNoise(t)).toBe('Reply.')
  })

  it('leaves ordinary prose that merely mentions a marker word alone', () => {
    const prose = 'The loop ends when the model writes LOOP_DONE at the end of a line.'
    // Not line-anchored at the start, so the sentence survives intact.
    expect(stripModelNoise(prose)).toBe(prose)
  })

  it('keeps legitimate tool-call JSON in plain chat (non aggressive)', () => {
    const lesson = 'OpenAI expects:\n```json\n{"name": "get_weather", "arguments": {"city": "Berlin"}}\n```'
    expect(stripModelNoise(lesson)).toContain('get_weather')
  })

  it('strips the same JSON when a tool loop is driving (aggressive)', () => {
    const leak = '```json\n{"name": "file_write", "arguments": {"path": "a.js", "content": "x"}}\n```'
    expect(stripModelNoise(leak, { aggressive: true })).toBe('')
  })

  // Captured verbatim off a live /loop turn on the 2.5.9 ship build. A loop
  // answer routinely NAMES the tool that proved it, so neither tier may treat
  // that sentence as a call and drop it. Pinned in both tiers because Agent and
  // Code send the same text down different paths.
  it.each([[{}], [{ aggressive: true }]])('keeps a real loop answer that names a tool in prose (%j)', (opts) => {
    const real = 'There are 2 files in the current directory: `greet.js` and `README.md`.\n\nLOOP_DONE\nCheck: file_list confirmed 2 files in the folder.'
    const out = stripModelNoise(real, opts)
    expect(out).toContain('There are 2 files')
    expect(out).toContain('Check: file_list confirmed 2 files')
    expect(out).not.toContain('LOOP_DONE')
  })

  it('returns empty for a block that was nothing but orchestration', () => {
    expect(stripModelNoise('LOOP_DONE')).toBe('')
    expect(stripModelNoise('ool_call>')).toBe('')
  })
})
