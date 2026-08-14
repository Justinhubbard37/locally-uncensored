/**
 * Benchmark Runner — runs standardized prompts against a model and measures performance.
 */

import { useCallback, useRef } from 'react'
import { useBenchmarkStore } from '../stores/benchmarkStore'
import { getProviderForModel } from '../api/providers'
import { BENCHMARK_PROMPTS } from '../lib/benchmark-prompts'
import { measureRun } from '../lib/benchmark-run'
import type { ChatMessage } from '../api/providers/types'

export function useBenchmark() {
  const store = useBenchmarkStore()
  const abortRef = useRef<AbortController | null>(null)
  // Stop has to reach the LOOP, not just the request in flight. Aborting the
  // stream only ended the current prompt; the next iteration opened a fresh
  // controller and carried on against the same model, so Stop looked like
  // "skip this one" (review 2026-08-14).
  const stoppedRef = useRef(false)
  // The guard cannot read store.isRunning: that value is captured when the
  // hook renders, so two clicks in the same frame both saw false and started
  // two loops on one GPU.
  const runningRef = useRef(false)

  const runBenchmark = useCallback(async (modelName: string) => {
    if (runningRef.current) return
    runningRef.current = true
    stoppedRef.current = false

    store.setRunning(true, modelName, BENCHMARK_PROMPTS.length)
    store.setError(null)

    try {
      for (let i = 0; i < BENCHMARK_PROMPTS.length; i++) {
        if (stoppedRef.current) break
        const prompt = BENCHMARK_PROMPTS[i]
        store.setStep(i + 1)

        abortRef.current = new AbortController()

        try {
          const { provider, modelId } = getProviderForModel(modelName)
          const messages: ChatMessage[] = [
            { role: 'user', content: prompt.prompt },
          ]

          const stream = provider.chatStream(modelId, messages, {
            temperature: 0.7,
            signal: abortRef.current.signal,
          })

          // The brake aborts the request itself, not just our reading of it:
          // dropping the stream would leave the model generating into nothing,
          // still holding the GPU (ElBiggus, issue #106).
          const controller = abortRef.current
          const m = await measureRun(stream, prompt.check, {
            onLimit: () => controller.abort(),
          })

          store.addResult({
            modelName,
            promptId: prompt.id,
            tokensPerSec: m.tokensPerSec,
            timeToFirstToken: m.timeToFirstToken,
            totalTime: m.totalTime,
            totalTokens: m.totalTokens,
            thinkTokens: m.thinkTokens,
            finishReason: m.finishReason,
            correct: m.correct,
            timestamp: Date.now(),
          })
        } catch (e) {
          // A prompt the user stopped is not a failure. Anything else is, and
          // it used to vanish into a bare catch: a model that could not be
          // reached at all produced an empty run that read exactly like a
          // finished one, with no message anywhere.
          if (stoppedRef.current || abortRef.current?.signal.aborted) break
          store.setError(
            `${modelName}: ${e instanceof Error ? e.message : String(e)}. ` +
            'Nothing was recorded for this run.',
          )
          break
        }
      }
    } finally {
      abortRef.current = null
      runningRef.current = false
      store.setRunning(false)
    }
  }, [store])

  const stopBenchmark = useCallback(() => {
    // Order matters: the flag first, so the loop cannot start the next prompt
    // between the abort and the check. setRunning stays out of here, the run's
    // own finally owns it, or Stop would re-enable Run while the loop is still
    // winding down and a second loop could start on the same GPU.
    stoppedRef.current = true
    abortRef.current?.abort()
  }, [])

  return { runBenchmark, stopBenchmark }
}
