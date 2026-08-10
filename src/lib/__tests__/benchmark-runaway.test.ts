/**
 * The emergency brake and the ranking, both from ElBiggus (issue #106, RTX
 * 5080 / Win11 25h2).
 *
 * He reported two things. `qwen3.5:9b` derails into a loop and produces two
 * orders of magnitude more tokens than the task needs, and the benchmark just
 * sits there with no way to tell a long run from a dead one. And the board is
 * ordered by tok/s alone, which reads as a black box because correctness is
 * measured and then not used for anything.
 *
 * Run: npx vitest run src/lib/__tests__/benchmark-runaway.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { measureRun, RUNAWAY_TOKEN_CAP, RUNAWAY_MS_CAP } from '../benchmark-run'
import { getLeaderboard, rankingScore } from '../../stores/benchmarkStore'
import type { BenchmarkResult } from '../benchmark-prompts'
import type { ChatStreamChunk } from '../../api/providers/types'

/** A model that never stops. Counts what it was allowed to emit. */
function loopingStream(emitted: { n: number }): AsyncGenerator<ChatStreamChunk> {
  return (async function* () {
    for (;;) {
      emitted.n++
      yield { content: '9, ', done: false } as ChatStreamChunk
    }
  })()
}

const alwaysCorrect = () => true

describe('the emergency brake', () => {
  it('stops a looping model instead of hanging, and says why', async () => {
    const emitted = { n: 0 }
    const m = await measureRun(loopingStream(emitted), alwaysCorrect, { maxTokens: 50 })
    expect(m.finishReason).toBe('runaway')
    // Bounded, and bounded near the cap rather than some multiple of it.
    expect(emitted.n).toBeLessThanOrEqual(52)
  })

  it('a run the brake stopped counts as wrong even if the text would pass', async () => {
    // The check says true for anything here. A run that never terminated did
    // not answer the question, so scoring it correct would put a broken model
    // at the top of the board, which is the bug turned inside out.
    const m = await measureRun(loopingStream({ n: 0 }), alwaysCorrect, { maxTokens: 20 })
    expect(m.correct).toBe(false)
  })

  it('aborts the request itself, so the model stops holding the GPU', async () => {
    const onLimit = vi.fn()
    await measureRun(loopingStream({ n: 0 }), alwaysCorrect, { maxTokens: 20, onLimit })
    expect(onLimit).toHaveBeenCalledWith('runaway')
  })

  it('the wall clock catches a machine too slow to reach the token cap', async () => {
    let t = 0
    const m = await measureRun(loopingStream({ n: 0 }), alwaysCorrect, {
      maxTokens: 1_000_000,
      maxMs: 1000,
      clock: () => (t += 400),
    })
    expect(m.finishReason).toBe('timeout')
    expect(m.correct).toBe(false)
  })

  it('NEGATIVE CONTROL: an honest run is never touched by either cap', async () => {
    // Fifty numbers plus reasoning is the longest thing the prompts can ask
    // for. If the caps could reach that, the fix would be worse than the bug.
    const chunks: Partial<ChatStreamChunk>[] = []
    for (let i = 1; i <= 400; i++) chunks.push({ content: `${i}\n` })
    chunks.push({ done: true, finishReason: 'stop' })
    const m = await measureRun(
      (async function* () { for (const c of chunks) yield { content: '', done: false, ...c } as ChatStreamChunk })(),
      alwaysCorrect,
    )
    expect(m.finishReason).toBe('stop')
    expect(m.correct).toBe(true)
  })

  it('the shipped caps leave real answers room by a wide margin', () => {
    expect(RUNAWAY_TOKEN_CAP).toBeGreaterThan(4000)
    expect(RUNAWAY_MS_CAP).toBeGreaterThanOrEqual(120_000)
  })
})

function run(model: string, tps: number, correct: boolean, finishReason = 'stop'): BenchmarkResult {
  return {
    modelName: model, promptId: 'reasoning', tokensPerSec: tps,
    timeToFirstToken: 100, totalTime: 1000, totalTokens: 100,
    thinkTokens: 0, finishReason, correct, timestamp: 1,
  }
}

describe('the ranking answers "why is this one first"', () => {
  it('a fast wrong model does not outrank a slower right one', () => {
    const results = {
      fastwrong: [run('fastwrong', 100, false), run('fastwrong', 100, false)],
      slowright: [run('slowright', 60, true), run('slowright', 60, true)],
    }
    const board = getLeaderboard(results)
    expect(board[0].model).toBe('slowright')
    expect(board[0].score).toBe(60)
    expect(board[1].score).toBe(0)

    // NEGATIVE CONTROL: the old order was raw speed, which puts the model
    // that is wrong every single time on top. That is the report.
    const oldOrder = [...board].sort((a, b) => b.avgTps - a.avgTps)
    expect(oldOrder[0].model).toBe('fastwrong')
  })

  it('half the answers wrong is half the useful throughput', () => {
    const results = { m: [run('m', 80, true), run('m', 80, false)] }
    expect(getLeaderboard(results)[0].score).toBe(40)
  })

  it('runs from before correctness scoring keep their raw rate', () => {
    // Dropping them to zero would silently rewrite an old board rather than
    // admit the number is missing; the accuracy column stays empty instead.
    expect(rankingScore(42, null)).toBe(42)
    const legacy = { ...run('old', 42, true), correct: undefined }
    const board = getLeaderboard({ old: [legacy] })
    expect(board[0].accuracy).toBeNull()
    expect(board[0].score).toBe(42)
  })

  it('equal usefulness falls back to raw speed, never to insertion order', () => {
    const results = {
      slow: [run('slow', 40, true)],
      quick: [run('quick', 80, true), run('quick', 80, false)],
    }
    const board = getLeaderboard(results)
    expect(board.map((e) => e.score)).toEqual([40, 40])
    expect(board[0].model).toBe('quick') // 80 raw beats 40 raw
  })

  it('a model that ran away is counted and shown apart from an honest cut-off', () => {
    const results = {
      m: [run('m', 90, false, 'runaway'), run('m', 90, false, 'timeout'), run('m', 90, false, 'length')],
    }
    const entry = getLeaderboard(results)[0]
    expect(entry.runaway).toBe(2)
    expect(entry.truncated).toBe(1)
    expect(entry.score).toBe(0)
  })
})
