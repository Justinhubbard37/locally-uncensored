import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { BenchmarkResult } from '../lib/benchmark-prompts'

interface BenchmarkState {
  results: Record<string, BenchmarkResult[]>
  isRunning: boolean
  currentModel: string | null
  currentStep: number
  totalSteps: number
  addResult: (result: BenchmarkResult) => void
  setRunning: (running: boolean, model?: string, total?: number) => void
  setStep: (step: number) => void
  /** Drop every recorded run. */
  clearResults: () => void
  /** Drop the runs for one model (renamed, re-quantized, deleted). */
  clearModel: (modelName: string) => void
  /** Drop runs for models that are no longer installed. M0j0Risin, D#21
   *  2026-07-30: "if you change models around, rename them, things get out of
   *  whack with older entries mixed in". */
  pruneMissing: (installedModelNames: string[]) => void
}

export const useBenchmarkStore = create<BenchmarkState>()(
  persist(
    (set) => ({
      results: {},
      isRunning: false,
      currentModel: null,
      currentStep: 0,
      totalSteps: 0,

      addResult: (result) => set((s) => {
        const existing = s.results[result.modelName] || []
        return {
          results: {
            ...s.results,
            [result.modelName]: [...existing, result],
          },
        }
      }),

      setRunning: (running, model, total) => set({
        isRunning: running,
        currentModel: model || null,
        totalSteps: total || 0,
        currentStep: 0,
      }),

      setStep: (step) => set({ currentStep: step }),

      clearResults: () => set({ results: {} }),

      clearModel: (modelName) => set((s) => {
        const { [modelName]: _dropped, ...rest } = s.results
        return { results: rest }
      }),

      pruneMissing: (installedModelNames) => set((s) => {
        const installed = new Set(installedModelNames)
        return {
          results: Object.fromEntries(
            Object.entries(s.results).filter(([model]) => installed.has(model)),
          ),
        }
      }),
    }),
    { name: 'lu-benchmark-store' }
  )
)

/** Models with no recorded run yet — what a "measure everything left" pass
 *  works through. */
export function unbenchmarked(results: Record<string, BenchmarkResult[]>, modelNames: string[]): string[] {
  return modelNames.filter((m) => !(results[m]?.length))
}

/** Models that hold runs but are not installed any more. */
export function staleModels(results: Record<string, BenchmarkResult[]>, installedModelNames: string[]): string[] {
  const installed = new Set(installedModelNames)
  return Object.keys(results).filter((m) => !installed.has(m))
}

/**
 * The whole benchmark table as Markdown, so it can be pasted into a report or
 * handed to a model (M0j0Risin, D#21: "it's possible to screen scrape it and
 * get a useful report but it would be cool to be able to export from the app").
 * Ranked like the leaderboard, with the run count and the latest session next
 * to the average so a single fast run cannot masquerade as a stable result.
 */
export function toMarkdownReport(
  results: Record<string, BenchmarkResult[]>,
  generatedAt: string,
): string {
  const board = getLeaderboard(results)
  const lines = [
    '# Local model benchmark',
    '',
    `Generated ${generatedAt} by Locally Uncensored.`,
    '',
  ]
  if (board.length === 0) {
    lines.push('No benchmark runs recorded yet.', '')
    return lines.join('\n')
  }
  lines.push(
    '| # | Model | Average t/s | Latest t/s | Runs |',
    '| --- | --- | ---: | ---: | ---: |',
  )
  board.forEach((entry, i) => {
    const latest = getLatestSpeed(results, entry.model)
    lines.push(`| ${i + 1} | ${entry.model} | ${entry.avgTps} | ${latest ?? '-'} | ${entry.runs} |`)
  })
  lines.push(
    '',
    `${board.reduce((s, e) => s + e.runs, 0)} runs across ${board.length} models.`,
    '',
    'Average is every recorded run. Latest is the most recent benchmark pass.',
    '',
  )
  return lines.join('\n')
}

/** Get average speed for a model (standalone, not a store method) */
export function getAverageSpeed(results: Record<string, BenchmarkResult[]>, modelName: string): number | null {
  const runs = results[modelName]
  if (!runs || runs.length === 0) return null
  const avg = runs.reduce((sum, r) => sum + r.tokensPerSec, 0) / runs.length
  return Math.round(avg * 10) / 10
}

/**
 * Get the LATEST benchmark tps for a model. The Benchmark view shows this
 * next to each model so the displayed number reflects the most recent run,
 * not a session-wide running average that quietly drifts as more samples
 * cancel noise.
 *
 * nightmare13740 (Discord 2026-05-23/24) flagged this on a Bug M retest:
 * gemma4:e4b read 15.2 tok/s on the first run and climbed to 17.9 after ten
 * runs. They thought previous results were affecting new ones — they were,
 * but only because the UI was averaging instead of showing the last sample.
 * The actual measurement was stable; the display was misleading.
 *
 * Per-prompt samples within ONE benchmark click stay averaged (BENCHMARK_PROMPTS
 * has multiple prompts and the average across them within a single session
 * gives a meaningful tok/s). The drift the user saw was across sessions —
 * each "Run Benchmark" click appended more samples without resetting.
 */
export function getLatestSpeed(results: Record<string, BenchmarkResult[]>, modelName: string): number | null {
  const runs = results[modelName]
  if (!runs || runs.length === 0) return null
  // Group consecutive runs by their addedAt timestamp into "sessions" — a
  // session is one click of Run Benchmark across BENCHMARK_PROMPTS prompts.
  // Anything within 10 s of the previous result counts as the same session.
  const SESSION_GAP_MS = 10_000
  let sessionStart = runs.length - 1
  for (let i = runs.length - 1; i > 0; i--) {
    if (runs[i].timestamp - runs[i - 1].timestamp > SESSION_GAP_MS) {
      sessionStart = i
      break
    }
    sessionStart = i - 1
  }
  const lastSession = runs.slice(sessionStart)
  const avg = lastSession.reduce((s, r) => s + r.tokensPerSec, 0) / lastSession.length
  return Math.round(avg * 10) / 10
}

/**
 * Compute tokens-per-second excluding time-to-first-token / stream init.
 *
 * Pre-v2.4.7 we used (tokenCount / totalTime), which lumped stream-init +
 * connection-setup + TTFT into the denominator and undercounted local model
 * speed. nightmare13740 (Discord 2026-05-19) caught this on RTX 4070 Laptop:
 * benchmark showed 12 tok/s, manual chat measurement 23-25 tok/s, ollama CLI
 * baseline 30 tok/s. Generation-phase rate (post-first-token) matches the CLI
 * within run-to-run noise, so we drop TTFT from the denominator and surface
 * it as its own stat.
 */
export function computeGenerationTps(
  tokenCount: number,
  totalTimeMs: number,
  firstTokenTimeMs: number,
): number {
  const generationTimeMs = totalTimeMs - firstTokenTimeMs
  if (generationTimeMs <= 0 || tokenCount <= 0) return 0
  return (tokenCount / generationTimeMs) * 1000
}

/** Get leaderboard sorted by avg tokens/sec */
export function getLeaderboard(results: Record<string, BenchmarkResult[]>): { model: string; avgTps: number; runs: number }[] {
  return Object.entries(results)
    .map(([model, runs]) => ({
      model,
      avgTps: Math.round((runs.reduce((s, r) => s + r.tokensPerSec, 0) / runs.length) * 10) / 10,
      runs: runs.length,
    }))
    .sort((a, b) => b.avgTps - a.avgTps)
}
