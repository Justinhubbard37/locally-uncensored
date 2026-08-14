/**
 * Stop has to stop the whole benchmark, and a failure has to be visible.
 *
 * Found reviewing the C1 fix (2026-08-14). The brake ElBiggus asked for
 * (issue #106) aborts the request in flight, and that part works. But
 * stopBenchmark only aborted the controller: the loop had no stop check, so
 * the next iteration opened a fresh controller and kept measuring the same
 * model. Stop read as "skip this prompt". Worse, it also called
 * setRunning(false), which re-enabled Run while the loop was still going, so a
 * second loop could start on the same GPU.
 *
 * The second half: every failure went into a bare `catch {}`. A model that
 * could not be reached at all produced a run with no results and no message,
 * indistinguishable from one that finished.
 *
 * Run: npx vitest run src/hooks/__tests__/benchmark-stop-and-errors.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { toMarkdownReport } from '../../stores/benchmarkStore'
import type { BenchmarkResult } from '../../lib/benchmark-prompts'

const here = dirname(fileURLToPath(import.meta.url))
const hook = readFileSync(resolve(here, '../useBenchmark.ts'), 'utf8')
const store = readFileSync(resolve(here, '../../stores/benchmarkStore.ts'), 'utf8')
const view = readFileSync(resolve(here, '../../components/models/BenchmarkView.tsx'), 'utf8')

describe('stop reaches the loop, not just the request', () => {
  it('the loop checks the stop flag before every prompt', () => {
    const loop = hook.slice(hook.indexOf('for (let i = 0'), hook.indexOf('} finally {'))
    expect(loop).toContain('if (stoppedRef.current) break')
    // The check sits at the TOP of the body, ahead of opening a controller.
    expect(loop.indexOf('if (stoppedRef.current) break'))
      .toBeLessThan(loop.indexOf('new AbortController()'))
  })

  it('stopBenchmark sets the flag before it aborts', () => {
    const stop = hook.slice(hook.indexOf('const stopBenchmark'))
    expect(stop.indexOf('stoppedRef.current = true')).toBeLessThan(stop.indexOf('abort()'))
  })

  it('stopBenchmark does not re-enable Run, the run owns that', () => {
    const stop = hook.slice(hook.indexOf('const stopBenchmark'), hook.indexOf('return { runBenchmark'))
    expect(stop).not.toContain('store.setRunning')
    expect(hook).toContain('      store.setRunning(false)\n    }')
  })

  it('the re-entry guard is a ref, so two clicks in one frame cannot both pass', () => {
    expect(hook).toContain('if (runningRef.current) return')
    expect(hook).not.toContain('if (store.isRunning) return')
  })
})

describe('a failure says so', () => {
  it('the catch records the model and the message instead of swallowing it', () => {
    expect(hook).toContain('store.setError(')
    expect(hook).not.toMatch(/\} catch \{\s*\n\s*\/\/ Aborted or error/)
  })

  it('a stopped prompt is not reported as a failure', () => {
    const c = hook.slice(hook.indexOf('} catch (e) {'))
    expect(c.indexOf('if (stoppedRef.current || abortRef.current?.signal.aborted) break'))
      .toBeLessThan(c.indexOf('store.setError('))
  })

  it('the store carries the field and the view renders it', () => {
    expect(store).toContain('setError: (message) => set({ error: message })')
    expect(view).toContain('const benchError = useBenchmarkStore((s) => s.error)')
    expect(view).toContain('{benchError && (')
  })

  it('run state is not persisted, a crash must not grey out Run forever', () => {
    expect(store).toContain('partialize: (s) => ({ results: s.results })')
  })

  it('the queue stops at the first failure instead of marching on in silence', () => {
    expect(view).toContain('if (useBenchmarkStore.getState().error) break')
  })
})

describe('the exported report matches the board it claims to be', () => {
  const run = (over: Partial<BenchmarkResult>): BenchmarkResult => ({
    modelName: 'm', promptId: 'p1', tokensPerSec: 20, timeToFirstToken: 100,
    totalTime: 1000, totalTokens: 400, thinkTokens: 0, finishReason: 'stop',
    correct: true, timestamp: 1, ...over,
  })

  it('prints the score it is sorted by', () => {
    const md = toMarkdownReport({ fast: [run({ modelName: 'fast' })] }, 'now')
    expect(md).toContain('| Score |')
    expect(md).toMatch(/\| 1 \| fast \| \d/)
  })

  it('marks a run the brake stopped, not only one cut off by the budget', () => {
    const md = toMarkdownReport({
      wild: [run({ modelName: 'wild', finishReason: 'runaway' }), run({ modelName: 'wild' })],
    }, 'now')
    expect(md).toContain('stopped by the brake')
  })

  it('says both in the footer, so the marks are explained', () => {
    const md = toMarkdownReport({ m: [run({})] }, 'now')
    expect(md).toContain('stopped by the brake is marked')
    expect(md).toContain('Score is what the')
  })
})
