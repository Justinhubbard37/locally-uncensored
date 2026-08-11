/**
 * A restart, and therefore every update, used to empty the approval queue: the
 * store lived in memory only. Morgan finished a run on 2026-08-11 whose file
 * changes could not be applied, and updating to the fix would have thrown them
 * away before he could retry them.
 *
 * This is the real proof, not a source guard: a fresh module load (which is
 * what a restart is) against a database that already holds a queue.
 *
 * Run: npx vitest run src/stores/__tests__/stagedChangesStore-rehydrate.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const DAY = 24 * 60 * 60 * 1000

const disk = vi.hoisted(() => ({ value: null as string | null }))

// idbStorage answers synchronously when IndexedDB is absent, which is exactly
// the node case here, so hydration stays synchronous.
vi.mock('../../lib/idbStorage', () => ({
  idbStorage: {
    getItem: (_name: string) => disk.value,
    setItem: (_name: string, value: string) => {
      disk.value = value
    },
    removeItem: () => {
      disk.value = null
    },
  },
}))

function writeDisk(entries: Record<string, unknown[]>) {
  disk.value = JSON.stringify({ state: { byChat: entries }, version: 0 })
}

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  path: 'src/main.py',
  resolvedPath: '/proj/src/main.py',
  workingDirectory: '/proj',
  oldContent: 'before',
  newContent: 'after the agent wrote it',
  diff: '',
  stagedAt: Date.now() - DAY,
  ...over,
})

beforeEach(() => {
  vi.resetModules()
  disk.value = null
})

describe('a restart with a queue on disk', () => {
  it('brings the pending change back, content and jail root intact', async () => {
    writeDisk({ 'chat-7': [entry()] })

    const { useStagedChangesStore } = await import('../stagedChangesStore')

    const list = useStagedChangesStore.getState().list('chat-7')
    expect(list).toHaveLength(1)
    expect(list[0].newContent).toBe('after the agent wrote it')
    // Apply runs after the loop cleared the active context, so these two are
    // what make the write land in the real project folder.
    expect(list[0].resolvedPath).toBe('/proj/src/main.py')
    expect(list[0].workingDirectory).toBe('/proj')
  })

  it('starts clean when the database holds nothing or holds junk', async () => {
    const fresh = await import('../stagedChangesStore')
    expect(fresh.useStagedChangesStore.getState().byChat).toEqual({})

    vi.resetModules()
    disk.value = 'not json at all'
    const broken = await import('../stagedChangesStore')
    expect(broken.useStagedChangesStore.getState().byChat).toEqual({})
  })

  it('leaves a fortnight-old change behind instead of hoarding it forever', async () => {
    writeDisk({ 'chat-7': [entry({ stagedAt: Date.now() - 15 * DAY })] })
    const { useStagedChangesStore } = await import('../stagedChangesStore')
    expect(useStagedChangesStore.getState().list('chat-7')).toEqual([])
  })

  it('writes what it staged back out, so the next restart finds it', async () => {
    const { useStagedChangesStore, flushStagedPersist } = await import('../stagedChangesStore')
    useStagedChangesStore.getState().stage('chat-9', {
      path: 'app.py',
      oldContent: 'old',
      newContent: 'new',
      diff: '',
    })
    await flushStagedPersist()

    expect(disk.value).toBeTruthy()
    const written = JSON.parse(disk.value as string)
    expect(written.state.byChat['chat-9'][0].newContent).toBe('new')
  })
})
