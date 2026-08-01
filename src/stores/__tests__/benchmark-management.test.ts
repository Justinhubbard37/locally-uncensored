/**
 * Benchmark housekeeping (M0j0Risin, D#21 2026-07-30, after a week of using
 * the feature): clear the data from the UI instead of hunting for it in the
 * file system, purge entries for models that no longer exist ("if you change
 * models around, rename them, things get out of whack with older entries mixed
 * in"), export the table in a form a model can read, and kick off the ones
 * that have not been measured yet.
 *
 * Run: npx vitest run src/stores/__tests__/benchmark-management.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  useBenchmarkStore, toMarkdownReport, unbenchmarked, staleModels, getLeaderboard,
} from '../benchmarkStore'
import type { BenchmarkResult } from '../../lib/benchmark-prompts'

const run = (modelName: string, tps: number, timestamp: number): BenchmarkResult =>
  ({ modelName, tokensPerSec: tps, timestamp } as BenchmarkResult)

const seed = (results: Record<string, BenchmarkResult[]>) =>
  useBenchmarkStore.setState({ results })

beforeEach(() => {
  useBenchmarkStore.setState({ results: {}, isRunning: false, currentModel: null, currentStep: 0, totalSteps: 0 })
})

describe('clearing', () => {
  it('clearResults empties the table', () => {
    seed({ 'qwen3:8b': [run('qwen3:8b', 20, 1)] })
    useBenchmarkStore.getState().clearResults()
    expect(useBenchmarkStore.getState().results).toEqual({})
  })

  it('clearModel drops one model and leaves the rest', () => {
    seed({ 'qwen3:8b': [run('qwen3:8b', 20, 1)], 'gemma4:e4b': [run('gemma4:e4b', 15, 1)] })
    useBenchmarkStore.getState().clearModel('qwen3:8b')
    expect(Object.keys(useBenchmarkStore.getState().results)).toEqual(['gemma4:e4b'])
  })

  it('clearModel on an unknown name changes nothing', () => {
    seed({ 'qwen3:8b': [run('qwen3:8b', 20, 1)] })
    useBenchmarkStore.getState().clearModel('not-here')
    expect(Object.keys(useBenchmarkStore.getState().results)).toEqual(['qwen3:8b'])
  })

  it('pruneMissing keeps only models that are still installed', () => {
    seed({
      'qwen3:8b': [run('qwen3:8b', 20, 1)],
      'old-model-renamed': [run('old-model-renamed', 9, 1)],
      'gemma4:e4b': [run('gemma4:e4b', 15, 1)],
    })
    useBenchmarkStore.getState().pruneMissing(['qwen3:8b', 'gemma4:e4b'])
    expect(Object.keys(useBenchmarkStore.getState().results).sort()).toEqual(['gemma4:e4b', 'qwen3:8b'])
  })

  it('pruneMissing with nothing installed empties the table', () => {
    seed({ 'qwen3:8b': [run('qwen3:8b', 20, 1)] })
    useBenchmarkStore.getState().pruneMissing([])
    expect(useBenchmarkStore.getState().results).toEqual({})
  })
})

describe('what still needs measuring / what is stale', () => {
  const results = {
    'qwen3:8b': [run('qwen3:8b', 20, 1)],
    'gone:7b': [run('gone:7b', 11, 1)],
    'empty:3b': [] as BenchmarkResult[],
  }

  it('unbenchmarked lists installed models with no run, including an empty array', () => {
    expect(unbenchmarked(results, ['qwen3:8b', 'gemma4:e4b', 'empty:3b'])).toEqual(['gemma4:e4b', 'empty:3b'])
  })

  it('unbenchmarked is empty when everything has a result', () => {
    expect(unbenchmarked(results, ['qwen3:8b'])).toEqual([])
  })

  it('staleModels lists recorded models that are not installed any more', () => {
    expect(staleModels(results, ['qwen3:8b', 'empty:3b'])).toEqual(['gone:7b'])
  })
})

describe('markdown export', () => {
  it('renders a ranked table with runs and the latest pass', () => {
    seed({
      'fast:3b': [run('fast:3b', 40, 1_000), run('fast:3b', 42, 2_000)],
      'slow:70b': [run('slow:70b', 4, 1_000)],
    })
    const md = toMarkdownReport(useBenchmarkStore.getState().results, '2026-08-01 12:00')

    expect(md).toContain('# Local model benchmark')
    expect(md).toContain('2026-08-01 12:00')
    expect(md).toContain('| # | Model | Average t/s | Latest t/s | Runs |')
    // Ranked fastest first, same order as the leaderboard on screen.
    expect(md.indexOf('fast:3b')).toBeLessThan(md.indexOf('slow:70b'))
    expect(md).toMatch(/\| 1 \| fast:3b \| 41 \|/)
    expect(md).toMatch(/\| 2 \| slow:70b \| 4 \|/)
    expect(md).toContain('3 runs across 2 models.')
  })

  it('says so plainly when there is nothing to export', () => {
    const md = toMarkdownReport({}, '2026-08-01 12:00')
    expect(md).toContain('No benchmark runs recorded yet.')
    expect(md).not.toContain('| # |')
  })

  it('the export agrees with the leaderboard on screen', () => {
    seed({ a: [run('a', 10, 1)], b: [run('b', 30, 1)], c: [run('c', 20, 1)] })
    const results = useBenchmarkStore.getState().results
    const order = getLeaderboard(results).map((e) => e.model)
    const md = toMarkdownReport(results, 'now')
    const positions = order.map((m) => md.indexOf(`| ${m} |`))
    expect(positions).toEqual([...positions].sort((x, y) => x - y))
  })
})
