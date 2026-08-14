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

// The merge was silently restoring deleted work. Found by the review of B4
// (2026-08-14) and reproduced against the real function before the fix:
//
//   base   console.log("debug") + a function
//   disk   the user deleted the debug line in their editor
//   staged the model added an import at the top
//   result ok:true, and the debug line was BACK
//
// Cause: collides() answered the conflict question, and the group builder used
// the same answer to decide membership. An insertion at exactly the first line
// of a replaced block does not conflict, so it was not grouped; it opened its
// own group whose span lay behind the write cursor, the cursor moved backwards,
// and the tail loop re-emitted base lines the other side had deleted. On a
// larger block the whole replaced block came back alongside its replacement.
describe('an insertion at the first line of a changed block', () => {
  const base = 'console.log("debug")\nexport function go() {\n  return 1\n}\n'

  it('does not bring back the line the user deleted on disk', () => {
    const disk = 'export function go() {\n  return 1\n}\n'
    const staged = 'import { go2 } from "./go2"\n' + base
    const r = mergeThreeWay(base, disk, staged)

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content).not.toContain('console.log("debug")')
    expect(r.content).toBe('import { go2 } from "./go2"\nexport function go() {\n  return 1\n}\n')
  })

  it('lands above the block, not below it', () => {
    const disk = 'console.log("kept")\nexport function go() {\n  return 1\n}\n'
    const staged = 'import { go2 } from "./go2"\n' + base
    const r = mergeThreeWay(base, disk, staged)

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content.split('\n')[0]).toBe('import { go2 } from "./go2"')
    expect(r.content).toContain('console.log("kept")')
  })

  it('does not duplicate a replaced block', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `L${i}`)
    const base40 = lines.join('\n') + '\n'
    const d = [...lines]; d.splice(10, 5, 'DISK-A', 'DISK-B', 'DISK-C', 'DISK-D', 'DISK-E')
    const s = [...lines]; s.splice(10, 0, 'STAGED-1', 'STAGED-2')
    const r = mergeThreeWay(base40, d.join('\n') + '\n', s.join('\n') + '\n')

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content).toContain('DISK-A')
    expect(r.content).toContain('STAGED-1')
    expect(r.content).not.toMatch(/^L10$/m)
    expect(r.content.trimEnd().split('\n')).toHaveLength(42)
  })
})

// The property that matters on the apply path: whatever we write must still
// contain the user's disk state. Stripping the lines the staged side added has
// to give back exactly what was on disk. 6000 random pairs, the same shape the
// review fuzzed with.
describe('a merged write never resurrects disk content', () => {
  it('holds across random disk edits and staged insertions', () => {
    let rng = 1234567
    const rand = (n: number) => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n }
    let checked = 0

    for (let iter = 0; iter < 6000; iter++) {
      const len = 4 + rand(12)
      const baseArr = Array.from({ length: len }, (_, i) => `line${i}`)
      const at = rand(len)
      const take = rand(Math.min(4, len - at)) + 1
      const diskArr = [...baseArr]
      diskArr.splice(at, take, ...Array.from({ length: rand(3) }, (_, k) => `DISK${iter}_${k}`))
      const insAt = rand(len + 1)
      const marker = `STAGED${iter}`
      const stagedArr = [...baseArr]
      stagedArr.splice(insAt, 0, marker)

      const r = mergeThreeWay(baseArr.join('\n'), diskArr.join('\n'), stagedArr.join('\n'))
      if (!r.ok) continue
      checked++
      const withoutInsert = r.content.split('\n').filter((l) => l !== marker).join('\n')
      expect(withoutInsert, `iter ${iter}`).toBe(diskArr.join('\n'))
    }
    expect(checked).toBeGreaterThan(3000)
  })
})
