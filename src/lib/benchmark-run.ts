/**
 * The per-prompt measurement, lifted out of the React hook so it can be tested
 * against a synthetic stream instead of a live model.
 *
 * It consumes one chat stream and reports not just how fast the model ran but
 * how much it spent, how much of that went into reasoning, why it stopped, and
 * whether the answer was actually right (David 2026-08-05). The clock is
 * injected so a test can make the timing deterministic; production passes
 * performance.now.
 */

import type { ChatStreamChunk } from '../api/providers/types'
import { computeGenerationTps } from '../stores/benchmarkStore'

export interface RunMeasurement {
  tokensPerSec: number
  timeToFirstToken: number
  totalTime: number
  totalTokens: number
  thinkTokens: number
  finishReason?: string
  correct: boolean
}

export async function measureRun(
  stream: AsyncIterable<ChatStreamChunk>,
  check: (answer: string) => boolean,
  clock: () => number = () => performance.now(),
): Promise<RunMeasurement> {
  const startTime = clock()
  let firstTokenTime = 0
  let contentCount = 0
  let thinkCount = 0
  let answerText = ''
  let finishReason: string | undefined
  let apiEvalCount: number | undefined
  let apiEvalDurationMs: number | undefined

  for await (const chunk of stream) {
    // Time to first token is the first output of any kind: for a model that
    // reasons out loud the thinking arrives before the answer, and starting
    // the clock only at the first answer token would hide the whole reasoning
    // phase from the generation rate below.
    if ((chunk.content || chunk.thinking) && firstTokenTime === 0) {
      firstTokenTime = clock() - startTime
    }
    if (chunk.thinking) thinkCount++
    if (chunk.content) {
      answerText += chunk.content
      contentCount++
    }
    if (chunk.finishReason) finishReason = chunk.finishReason
    // Bug M v2.4.7 — Ollama reports authoritative gen metrics in the done:true
    // chunk. Prefer these over client-side timing because WebView2 release-mode
    // buffers the response stream for fast small models, collapsing
    // firstTokenTime to ~totalTime and producing absurd JS-measured tps values.
    if (chunk.evalCount !== undefined && chunk.evalCount > 0) {
      apiEvalCount = chunk.evalCount
    }
    if (chunk.evalDurationMs !== undefined && chunk.evalDurationMs > 0) {
      apiEvalDurationMs = chunk.evalDurationMs
    }
  }

  const totalTime = clock() - startTime

  // totalTokens is the whole output, thinking included, so a model that reasons
  // out loud and one that does not are counted the same way (David 2026-08-05:
  // two 9B models tied on tok/s, one spent 8975 tokens where the other spent
  // 5480 for the same answers). Ollama's evalCount already folds thinking into
  // the count; the JS fallback adds the two chunk counters to match. thinkShare
  // is a ratio of the same chunk units on both paths, so it stays comparable
  // regardless of which branch produced the token total.
  const jsTotal = contentCount + thinkCount
  const thinkShare = jsTotal > 0 ? thinkCount / jsTotal : 0

  // Three-way TPS branch for Bug M (v2.4.7):
  //   1. Provider returned authoritative server metrics (Ollama via
  //      eval_count/eval_duration) -> use them. Most accurate.
  //   2. JS measurement with a real generation phase -> use the post-TTFT
  //      formula (the original Bug M fix). Works for providers that do not
  //      return server metrics but where the stream actually streams.
  //   3. JS measurement collapsed to ~0ms generation phase -> the response was
  //      buffered (Tauri Rust proxy in release-mode collects all bytes before
  //      returning, or WebView2 aggregates TCP packets for fast responses). The
  //      post-TTFT formula would divide by ~0 and produce absurd values like
  //      685k tok/s. Fall back to wall-clock rate (tokens/totalTime). It
  //      under-counts because it includes load and TTFT time but at least is
  //      sane, and a real improvement over pre-v2.4.7 where this case also
  //      produced garbage just via a different formula path.
  const generationTimeMs = totalTime - firstTokenTime
  const hasApiMetrics = apiEvalCount !== undefined && apiEvalDurationMs !== undefined
  const isBuffered = !hasApiMetrics && generationTimeMs < 100 && totalTime > 0
  const reportedTokens = hasApiMetrics ? apiEvalCount! : jsTotal
  const reportedTps = hasApiMetrics
    ? (apiEvalCount! / apiEvalDurationMs!) * 1000
    : isBuffered
      ? (jsTotal / totalTime) * 1000
      : computeGenerationTps(jsTotal, totalTime, firstTokenTime)

  return {
    tokensPerSec: reportedTps,
    timeToFirstToken: firstTokenTime,
    totalTime,
    totalTokens: reportedTokens,
    // thinkShare is measured in chunk units; scaling the authoritative token
    // total by it keeps thinkTokens in the same unit as totalTokens, so
    // thinkTokens / totalTokens is a valid ratio even when the total came from
    // Ollama's evalCount rather than the counters.
    thinkTokens: Math.round(reportedTokens * thinkShare),
    finishReason,
    // The answer is the visible output only. A model that reasoned its way to
    // the right number but never printed it fails here, which is the whole
    // point of measuring correctness next to speed.
    correct: check(answerText),
  }
}
