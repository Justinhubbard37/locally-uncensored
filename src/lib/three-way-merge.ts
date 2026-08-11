/**
 * Line-level three-way merge for staged changes.
 *
 * Morgan, 2026-08-11: every file in his finished run refused to apply with
 * "changed on disk after this edit was staged", so a six-step plan that the
 * plan bar reported as done wrote nothing at all. The guard was right (the
 * file really had moved on, he runs other tools in the same folder), but a
 * guard whose only exit is Reject all throws away work the customer paid for.
 *
 * Almost always the two edits sit in different places in the file, and then
 * there is nothing to decide: take both. Only when the same lines moved on
 * both sides is there a real question, and only that case still refuses.
 *
 * Built on `diffLines` from ./diff, the same line diff the reviewed diff is
 * rendered from, so the merge can never disagree with what the user saw.
 */

import { diffLines } from './diff'

export type MergeResult =
  /** `content` is safe to write. `mergedRegions` counts the foreign edits kept. */
  | { ok: true; content: string; mergedRegions: number }
  /** The same lines changed on both sides. `conflicts` counts the spots. */
  | { ok: false; conflicts: number }

/** A stretch of base lines [start, end) that one side replaced with `lines`. */
interface Region {
  start: number
  end: number
  lines: string[]
}

function split(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

/** Every place `side` differs from `base`, in base coordinates. */
function regionsOf(base: string[], side: string[]): Region[] {
  const out: Region[] = []
  let cursor = 0
  const ops = diffLines(base, side)
  for (let i = 0; i < ops.length; ) {
    if (ops[i].kind === 'equal') {
      cursor += ops[i].text.length
      i++
      continue
    }
    const start = cursor
    let lines: string[] = []
    // A replacement arrives as a remove run next to an add run; both belong to
    // the same region, otherwise the add would be treated as a second edit at
    // the position the remove already consumed.
    while (i < ops.length && ops[i].kind !== 'equal') {
      if (ops[i].kind === 'remove') {
        cursor += ops[i].text.length
      } else {
        lines = lines.concat(ops[i].text)
      }
      i++
    }
    out.push({ start, end: cursor, lines })
  }
  return out
}

/**
 * Do these two base spans have to be judged together?
 *
 * Replacements collide when their spans really overlap. A pure insertion owns
 * no base line, so it only collides with a replacement it sits INSIDE of:
 * appending at the end of a block the other side rewrote is an everyday
 * combination (the model adds a route, someone else fixes the line above it)
 * and treating it as a collision would refuse most real merges. Two different
 * insertions in the same gap do collide, because their order would otherwise be
 * ours by accident.
 */
function collides(a: Region, b: Region): boolean {
  const aInsert = a.start === a.end
  const bInsert = b.start === b.end
  if (aInsert && bInsert) return a.start === b.start
  if (aInsert) return a.start > b.start && a.start < b.end
  if (bInsert) return b.start > a.start && b.start < a.end
  return a.start < b.end && b.start < a.end
}

/** The result of applying one side's regions across [start, end). */
function rewrite(base: string[], regions: Region[], start: number, end: number): string[] {
  const out: string[] = []
  let cursor = start
  for (const r of regions) {
    for (let i = cursor; i < r.start; i++) out.push(base[i])
    for (const line of r.lines) out.push(line)
    cursor = r.end
  }
  for (let i = cursor; i < end; i++) out.push(base[i])
  return out
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i])
}

/**
 * Merge `ours` (what is on disk now) and `theirs` (what we staged) over their
 * common `base` (the disk content at stage time).
 */
export function mergeThreeWay(base: string, ours: string, theirs: string): MergeResult {
  if (ours === base) return { ok: true, content: theirs, mergedRegions: 0 }
  if (theirs === base) return { ok: true, content: ours, mergedRegions: 0 }
  if (ours === theirs) return { ok: true, content: theirs, mergedRegions: 0 }

  const baseLines = split(base)
  const ourRegions = regionsOf(baseLines, split(ours))
  const theirRegions = regionsOf(baseLines, split(theirs))

  const out: string[] = []
  let cursor = 0
  let oi = 0
  let ti = 0
  let mergedRegions = 0
  let conflicts = 0

  while (oi < ourRegions.length || ti < theirRegions.length) {
    // Open the group with whichever side comes first in the file.
    const mine: Region[] = []
    const yours: Region[] = []
    const ourNext = ourRegions[oi]
    const theirNext = theirRegions[ti]
    const startWithOurs = !theirNext || (ourNext && ourNext.start <= theirNext.start)
    const first = startWithOurs ? ourRegions[oi++] : theirRegions[ti++]
    ;(startWithOurs ? mine : yours).push(first)
    const start = first.start
    let end = first.end

    // Then pull in everything from either side that collides with the growing
    // span, so a chain of edits over the same lines is judged as one unit.
    for (let grew = true; grew; ) {
      grew = false
      while (oi < ourRegions.length && collides(ourRegions[oi], { start, end, lines: [] })) {
        end = Math.max(end, ourRegions[oi].end)
        mine.push(ourRegions[oi])
        oi++
        grew = true
      }
      while (ti < theirRegions.length && collides(theirRegions[ti], { start, end, lines: [] })) {
        end = Math.max(end, theirRegions[ti].end)
        yours.push(theirRegions[ti])
        ti++
        grew = true
      }
    }

    for (let i = cursor; i < start; i++) out.push(baseLines[i])

    if (mine.length === 0 || yours.length === 0) {
      const only = mine.length === 0 ? yours : mine
      for (const line of rewrite(baseLines, only, start, end)) out.push(line)
      if (mine.length > 0) mergedRegions++
    } else {
      const a = rewrite(baseLines, mine, start, end)
      const b = rewrite(baseLines, yours, start, end)
      if (same(a, b)) {
        // Both sides arrived at the same text. Nothing to decide.
        for (const line of a) out.push(line)
      } else {
        conflicts++
      }
    }
    cursor = end
  }

  if (conflicts > 0) return { ok: false, conflicts }

  for (let i = cursor; i < baseLines.length; i++) out.push(baseLines[i])
  return { ok: true, content: out.join('\n'), mergedRegions }
}
