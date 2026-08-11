/**
 * mergeThreeWay decides whether a staged change can still land after the file
 * moved on. Two edits in different places must both survive; two edits in the
 * same place must be refused, never silently picked.
 */
import { describe, it, expect } from 'vitest'
import { mergeThreeWay } from '../three-way-merge'

const lines = (...l: string[]) => l.join('\n')

const BASE = lines(
  'from fastapi import FastAPI',
  '',
  'app = FastAPI()',
  '',
  'def health() -> str:',
  '    return "ok"',
)

describe('mergeThreeWay', () => {
  it('keeps both edits when they sit in different places', () => {
    const ours = BASE.replace('app = FastAPI()', 'app = FastAPI(title="Graphify")')
    const theirs = lines(BASE, '', 'def payments() -> str:', '    return "btc"')

    const res = mergeThreeWay(BASE, ours, theirs)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.content).toContain('title="Graphify"')
    expect(res.content).toContain('def payments()')
    expect(res.mergedRegions).toBe(1)
  })

  it('refuses when both sides changed the same line', () => {
    const ours = BASE.replace('    return "ok"', '    return "healthy"')
    const theirs = BASE.replace('    return "ok"', '    return "OK"')

    const res = mergeThreeWay(BASE, ours, theirs)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.conflicts).toBe(1)
  })

  it('takes it once when both sides made the identical edit', () => {
    const same = BASE.replace('    return "ok"', '    return "healthy"')
    const res = mergeThreeWay(BASE, same, same)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.content).toBe(same)
    expect(res.content.match(/healthy/g)).toHaveLength(1)
  })

  it('refuses two different insertions in the same gap instead of writing both', () => {
    const ours = BASE.replace('app = FastAPI()', 'app = FastAPI()\napp.mount("/ours")')
    const theirs = BASE.replace('app = FastAPI()', 'app = FastAPI()\napp.mount("/theirs")')
    const res = mergeThreeWay(BASE, ours, theirs)
    expect(res.ok).toBe(false)
  })

  it('is the staged content when the disk never moved, and the disk content when the stage is a no-op', () => {
    const theirs = lines(BASE, 'x = 1')
    expect(mergeThreeWay(BASE, BASE, theirs)).toEqual({
      ok: true,
      content: theirs,
      mergedRegions: 0,
    })
    const ours = lines(BASE, 'y = 2')
    expect(mergeThreeWay(BASE, ours, BASE)).toEqual({ ok: true, content: ours, mergedRegions: 0 })
  })

  it('merges an edit at the top with a deletion at the bottom', () => {
    const ours = lines('# fresh header', ...BASE.split('\n'))
    const theirs = BASE.split('\n').slice(0, -1).join('\n')

    const res = mergeThreeWay(BASE, ours, theirs)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.content.startsWith('# fresh header')).toBe(true)
    expect(res.content).not.toContain('return "ok"')
  })

  it('counts every foreign region it carried over', () => {
    const ours = BASE.replace('from fastapi import FastAPI', 'from fastapi import FastAPI, Depends')
      .replace('    return "ok"', '    return "ok"  # noqa')
    const theirs = lines(BASE, 'router = None')

    const res = mergeThreeWay(BASE, ours, theirs)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.mergedRegions).toBe(2)
    expect(res.content).toContain('Depends')
    expect(res.content).toContain('# noqa')
    expect(res.content).toContain('router = None')
  })

  it('treats a file created on both sides with different content as a conflict', () => {
    const res = mergeThreeWay('', 'someone else wrote this', 'the model wrote this')
    expect(res.ok).toBe(false)
  })
})
