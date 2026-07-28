/**
 * Loop guard for the agent ReAct loops (Codex + Chat agent).
 *
 * Born from a live failure (Morgan, 2026-07-26): the coding agent repeated
 * the same file_read and the same narration line for 5 minutes. The old
 * detector only halted on the same batch signature 3× IN A ROW — alternating
 * batches, an injected nudge, or one varying argument reset the counter every
 * time, so a real loop never tripped it while the budget allowed 200
 * iterations of it.
 *
 * Four complementary detectors, all pure and cheap. The dividing line is the
 * mutation epoch: any side-effecting call (shell, write, git mutation) may
 * change what the next identical call returns, so repeat detection that spans
 * a mutation would punish legitimate edit → test → edit → test cycles. Every
 * epoch-scoped counter therefore resets on a mutating batch.
 *
 *  1. Identical batches back-to-back (old-guard parity, any tool class):
 *     3 in a row halts. Survives mutations on purpose — three byte-identical
 *     batches with nothing else between them is a stall even for shell.
 *
 *  2. Windowed signatures among PURE-READ batches: the same signature 3×
 *     within the last 6 read-only batches halts, consecutive or not. Catches
 *     the A,B,A,B,A alternation that detector 1 can never see.
 *
 *  3. Identical read calls within an epoch: a repeated read with
 *     byte-identical arguments cannot return new information while the
 *     workspace is unchanged. The 3rd identical read steers the model once,
 *     the 5th halts.
 *
 *  4. Repeated narration: the model emitting the same non-trivial text 3×
 *     in a row ("Let me check the rotation engine…") halts even when its
 *     tool calls vary enough to dodge 1-3.
 */

export type LoopGuardVerdict =
  | { action: 'ok' }
  | { action: 'steer'; message: string }
  | { action: 'halt'; reason: string }

const CONSECUTIVE_HALT_AT = 3
const BATCH_WINDOW = 6
const WINDOW_HALT_REPEATS = 3
const READ_STEER_AT = 3
const READ_HALT_AT = 5
const NARRATION_HALT_AT = 3
/** Ignore trivial repeated lines ("Done.", "ok") — too easy to hit honestly. */
const MIN_NARRATION_LEN = 12

/**
 * Tools whose result is a pure function of the workspace state. Only these
 * feed the epoch-scoped repeat counters; everything else (shell, writes, web,
 * time) may legitimately repeat and instead RESETS the epoch.
 */
const READ_ONLY_TOOLS = new Set<string>([
  'file_read',
  'file_list',
  'file_search',
  'git_status',
  'git_log',
  'git_diff',
])

export class AgentLoopGuard {
  private lastSig: string | null = null
  private consecutive = 0
  /** Batch signatures since the last mutating batch (pure-read epoch). */
  private pureWindow: string[] = []
  private readCounts = new Map<string, number>()
  private steeredKeys = new Set<string>()
  private lastNarration = ''
  private narrationSeen = 0

  /**
   * Record one iteration's tool-call batch BEFORE executing it. `args` must
   * be the serialized (stringified) arguments so identity is byte-exact —
   * the same convention the in-turn cache uses.
   */
  recordBatch(calls: Array<{ name: string; args: string }>): LoopGuardVerdict {
    if (calls.length === 0) return { action: 'ok' }
    const keys = calls.map((c) => `${c.name}|${c.args}`)
    const sig = [...keys].sort().join('||')

    // (1) Back-to-back identical batches, any tool class.
    if (sig === this.lastSig) {
      this.consecutive++
    } else {
      this.lastSig = sig
      this.consecutive = 1
    }
    if (this.consecutive >= CONSECUTIVE_HALT_AT) {
      return { action: 'halt', reason: `same tool sequence repeated ${this.consecutive}× in a row` }
    }

    const hasMutation = calls.some((c) => !READ_ONLY_TOOLS.has(c.name))

    // (2) Windowed repeats among pure-read batches (alternation).
    if (!hasMutation) {
      this.pureWindow.push(sig)
      if (this.pureWindow.length > BATCH_WINDOW) this.pureWindow.shift()
      const repeats = this.pureWindow.filter((s) => s === sig).length
      if (repeats >= WINDOW_HALT_REPEATS) {
        return {
          action: 'halt',
          reason: `same tool sequence repeated ${repeats}× within the last ${this.pureWindow.length} steps with no workspace change`,
        }
      }
    }

    // (3) Identical read calls within the epoch.
    let steer: LoopGuardVerdict | null = null
    for (let i = 0; i < calls.length; i++) {
      if (!READ_ONLY_TOOLS.has(calls[i].name)) continue
      const n = (this.readCounts.get(keys[i]) ?? 0) + 1
      this.readCounts.set(keys[i], n)
      if (n >= READ_HALT_AT) {
        return {
          action: 'halt',
          reason: `${calls[i].name} repeated ${n}× with identical arguments and an unchanged workspace`,
        }
      }
      if (n >= READ_STEER_AT && !this.steeredKeys.has(keys[i])) {
        this.steeredKeys.add(keys[i])
        steer = {
          action: 'steer',
          message:
            `You have now called ${calls[i].name} ${n} times with exactly the same arguments. ` +
            'Nothing changed in between, so the result is identical to the one you already have. ' +
            'Do NOT repeat this call again. Use the result from before, or take a DIFFERENT action that moves the task forward.',
        }
      }
    }

    if (hasMutation) {
      // A side-effecting call may change what reads return — give the
      // epoch-scoped counters a clean slate so a legitimate re-read after a
      // change is never punished. steeredKeys survives: one steer per unique
      // call is enough for the whole run.
      this.readCounts.clear()
      this.pureWindow = []
    }
    return steer ?? { action: 'ok' }
  }

  /** Record the assistant text of one iteration (before its tools run). */
  recordNarration(text: string): LoopGuardVerdict {
    const norm = text.trim().replace(/\s+/g, ' ').toLowerCase()
    if (norm.length < MIN_NARRATION_LEN) {
      this.lastNarration = ''
      this.narrationSeen = 0
      return { action: 'ok' }
    }
    if (norm === this.lastNarration) {
      this.narrationSeen++
    } else {
      this.lastNarration = norm
      this.narrationSeen = 1
    }
    if (this.narrationSeen >= NARRATION_HALT_AT) {
      return {
        action: 'halt',
        reason: `the model repeated the same message ${this.narrationSeen}× without making progress`,
      }
    }
    return { action: 'ok' }
  }
}
