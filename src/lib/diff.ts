// Minimal text-diff helpers for the Codex file_change event view.
//
// Not a full Myers diff — we use the LCS table for line-granularity, which
// is enough for "show me what the agent edited" and avoids pulling in
// diff-match-patch (~120 kB gz) just for the chat surface.
//
// `computeUnifiedDiff` returns a GNU-unified-diff string:
//
//   --- a/<path>
//   +++ b/<path>
//   @@ -3,4 +3,5 @@
//    context line
//   -removed
//   +added
//
// `parseUnifiedDiff` round-trips the same shape back to typed hunks so the
// renderer can paint each line without re-tokenising the string.

export interface DiffLine {
  kind: 'context' | 'add' | 'remove' | 'hunk' | 'header'
  text: string
  oldLine?: number
  newLine?: number
}

export interface ParsedDiff {
  path: string
  lines: DiffLine[]
  /** Summary stats. */
  added: number
  removed: number
}

/**
 * Build a unified diff between two text blobs at line granularity.
 *
 * `context` controls how many unchanged lines to keep around each hunk;
 * 3 mirrors `git diff` and stays readable inside the chat panel.
 */
export function computeUnifiedDiff(
  path: string,
  oldText: string,
  newText: string,
  context = 3,
): string {
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  const ops = diffLines(a, b)
  if (ops.every((o) => o.kind === 'equal')) {
    return ''
  }

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`]
  let i = 0
  let aLine = 0
  let bLine = 0
  while (i < ops.length) {
    // Skip stretches of equal lines that don't sit near a change.
    if (ops[i].kind === 'equal') {
      const skip = nearestChange(ops, i)
      if (skip === -1) {
        // Trailing equal block — nothing left to report.
        aLine += ops[i].text.length
        bLine += ops[i].text.length
        i++
        continue
      }
      const equalLen = ops[i].text.length
      const leading = Math.min(context, equalLen)
      const dropped = equalLen - leading
      aLine += dropped
      bLine += dropped
      // Re-enter the loop on the leading-context boundary.
      ops[i] = { kind: 'equal', text: ops[i].text.slice(dropped) }
    }

    // Collect a hunk: leading context + change run + trailing context.
    const hunkStartA = aLine
    const hunkStartB = bLine
    const hunkLines: string[] = []
    while (i < ops.length) {
      const op = ops[i]
      if (op.kind === 'equal') {
        // Close the hunk when the gap to the next change is wider than the
        // context we'd print on both sides — the git rule. This used to compare
        // op INDICES (`reach - i > 1`), and since equal runs are merged, the
        // next op is always a change, so the condition was never true: two edits
        // 200 lines apart came out as ONE hunk with 198 context lines. The panel
        // renders 40 lines, so the second edit was invisible in the diff the
        // user approved.
        const reach = nearestChange(ops, i)
        const headRoom = op.text.length
        if (reach === -1 || headRoom > context * 2) {
          const trailing = Math.min(context, headRoom)
          for (let k = 0; k < trailing; k++) {
            hunkLines.push(' ' + op.text[k])
          }
          aLine += headRoom
          bLine += headRoom
          if (reach === -1) {
            i = ops.length
          } else {
            const remaining = headRoom - trailing
            // Stash whatever's left of the equal block back into ops for the
            // *next* hunk's leading context.
            ops[i] = { kind: 'equal', text: op.text.slice(trailing) }
            aLine -= remaining
            bLine -= remaining
          }
          break
        }
        for (const t of op.text) {
          hunkLines.push(' ' + t)
        }
        aLine += headRoom
        bLine += headRoom
        i++
        continue
      }
      if (op.kind === 'remove') {
        for (const t of op.text) {
          hunkLines.push('-' + t)
        }
        aLine += op.text.length
        i++
        continue
      }
      // add
      for (const t of op.text) {
        hunkLines.push('+' + t)
      }
      bLine += op.text.length
      i++
    }

    const oldLen = hunkLines.filter((l) => l.startsWith(' ') || l.startsWith('-'))
      .length
    const newLen = hunkLines.filter((l) => l.startsWith(' ') || l.startsWith('+'))
      .length
    out.push(
      `@@ -${hunkStartA + 1},${oldLen} +${hunkStartB + 1},${newLen} @@`,
    )
    out.push(...hunkLines)
  }
  return out.join('\n')
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = diff.split('\n')
  const out: DiffLine[] = []
  let path = ''
  let oldLine = 0
  let newLine = 0
  let added = 0
  let removed = 0

  for (const raw of lines) {
    if (raw.startsWith('--- a/')) {
      path = raw.slice(6)
      out.push({ kind: 'header', text: raw })
      continue
    }
    if (raw.startsWith('+++ b/')) {
      if (!path) path = raw.slice(6)
      out.push({ kind: 'header', text: raw })
      continue
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (m) {
        oldLine = parseInt(m[1], 10)
        newLine = parseInt(m[2], 10)
      }
      out.push({ kind: 'hunk', text: raw })
      continue
    }
    if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), newLine })
      added++
      newLine++
      continue
    }
    if (raw.startsWith('-')) {
      out.push({ kind: 'remove', text: raw.slice(1), oldLine })
      removed++
      oldLine++
      continue
    }
    if (raw.startsWith(' ')) {
      out.push({ kind: 'context', text: raw.slice(1), oldLine, newLine })
      oldLine++
      newLine++
      continue
    }
    // Stray line (blank, malformed) — keep as context so the renderer can
    // still show it without throwing.
    if (raw !== '') {
      out.push({ kind: 'context', text: raw })
    }
  }
  return { path, lines: out, added, removed }
}

// ── internals ──────────────────────────────────────────────────────

type Op =
  | { kind: 'equal'; text: string[] }
  | { kind: 'add'; text: string[] }
  | { kind: 'remove'; text: string[] }

/**
 * The LCS table below is O(n·m) in MEMORY, and nothing caps it upstream —
 * measured, a 5000-line file cost 202 MB of heap and 122 ms just to render the
 * diff of a one-line edit. So: strip the identical head and tail first (an
 * agent editing one function in a large file leaves a tiny middle), and refuse
 * the table outright past a hard cell budget.
 */
const MAX_LCS_CELLS = 4_000_000

/** LCS-based line diff. Grouped into op runs for a compact unified format. */
function diffLines(a: string[], b: string[]): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++

  const ops: Op[] = []
  if (head > 0) append(ops, { kind: 'equal', text: a.slice(0, head) })
  for (const op of diffMiddle(a.slice(head, a.length - tail), b.slice(head, b.length - tail))) {
    append(ops, op)
  }
  if (tail > 0) append(ops, { kind: 'equal', text: a.slice(a.length - tail) })
  return ops
}

function diffMiddle(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if (n === 0) return [{ kind: 'add', text: b }]
  if (m === 0) return [{ kind: 'remove', text: a }]
  // Past the budget, report a whole-block replacement: still a correct diff,
  // just not a minimal one — and it costs no table at all.
  if (n * m > MAX_LCS_CELLS) {
    return [{ kind: 'remove', text: a }, { kind: 'add', text: b }]
  }

  // Classic dynamic-programming LCS table, one Int32Array per row.
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      append(ops, { kind: 'equal', text: [a[i]] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      append(ops, { kind: 'remove', text: [a[i]] })
      i++
    } else {
      append(ops, { kind: 'add', text: [b[j]] })
      j++
    }
  }
  while (i < n) {
    append(ops, { kind: 'remove', text: [a[i++]] })
  }
  while (j < m) {
    append(ops, { kind: 'add', text: [b[j++]] })
  }
  return ops
}

function append(ops: Op[], op: Op): void {
  const last = ops[ops.length - 1]
  if (last && last.kind === op.kind) {
    // Not `push(...op.text)` — whole-file runs reach this and spreading a
    // six-figure array overflows the argument limit.
    for (const t of op.text) last.text.push(t)
  } else {
    ops.push(op)
  }
}

function nearestChange(ops: Op[], from: number): number {
  for (let k = from + 1; k < ops.length; k++) {
    if (ops[k].kind !== 'equal') return k
  }
  return -1
}
