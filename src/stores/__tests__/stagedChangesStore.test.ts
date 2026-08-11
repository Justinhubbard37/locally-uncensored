import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { useStagedChangesStore, pruneStagedQueues } from '../stagedChangesStore'

describe('stagedChangesStore', () => {
  beforeEach(() => {
    useStagedChangesStore.setState({ byChat: {} })
  })

  it('starts empty', () => {
    expect(useStagedChangesStore.getState().list('c1')).toEqual([])
  })

  it('stages a change and returns an id', () => {
    const id = useStagedChangesStore.getState().stage('c1', {
      path: 'src/a.ts',
      oldContent: 'old',
      newContent: 'new',
      diff: 'diff body',
    })
    expect(typeof id).toBe('string')
    const list = useStagedChangesStore.getState().list('c1')
    expect(list).toHaveLength(1)
    expect(list[0].path).toBe('src/a.ts')
    expect(list[0].id).toBe(id)
    expect(list[0].stagedAt).toBeGreaterThan(0)
  })

  it('staging the same path twice keeps only the latest (path-keyed dedupe)', () => {
    useStagedChangesStore.getState().stage('c1', {
      path: 'src/a.ts',
      oldContent: 'old',
      newContent: 'v1',
      diff: 'd1',
    })
    useStagedChangesStore.getState().stage('c1', {
      path: 'src/a.ts',
      oldContent: 'old',
      newContent: 'v2',
      diff: 'd2',
    })
    const list = useStagedChangesStore.getState().list('c1')
    expect(list).toHaveLength(1)
    expect(list[0].newContent).toBe('v2')
  })

  // The queue used to dedupe on the raw string while every reader matches
  // normalized and on resolvedPath too. One file then sat in the queue twice,
  // the older entry was written first, and the newer one died in the drift
  // guard: the user lost the edit he approved (Morgan, 2026-08-11).
  it('one file is one entry, whatever spelling the model used', () => {
    const stage = (path: string, resolvedPath: string, newContent: string) =>
      useStagedChangesStore.getState().stage('c1', {
        path,
        resolvedPath,
        oldContent: 'base',
        newContent,
        diff: '',
      })

    stage('main.py', 'C:/proj/main.py', 'v1')
    stage('C:\\proj\\main.py', 'C:\\proj\\main.py', 'v2')
    stage('./main.py', 'C:/PROJ/main.py', 'v3')

    const list = useStagedChangesStore.getState().list('c1')
    expect(list).toHaveLength(1)
    expect(list[0].newContent).toBe('v3')
  })

  it('keeps two genuinely different files apart', () => {
    useStagedChangesStore.getState().stage('c1', {
      path: 'src/a.ts', resolvedPath: '/proj/src/a.ts', oldContent: '', newContent: 'x', diff: '',
    })
    useStagedChangesStore.getState().stage('c1', {
      path: 'lib/a.ts', resolvedPath: '/proj/lib/a.ts', oldContent: '', newContent: 'y', diff: '',
    })
    expect(useStagedChangesStore.getState().list('c1')).toHaveLength(2)
  })

  it('queues across chats are isolated', () => {
    useStagedChangesStore.getState().stage('c1', {
      path: 'a',
      oldContent: '',
      newContent: 'x',
      diff: '',
    })
    useStagedChangesStore.getState().stage('c2', {
      path: 'b',
      oldContent: '',
      newContent: 'y',
      diff: '',
    })
    expect(useStagedChangesStore.getState().list('c1').map((c) => c.path)).toEqual(['a'])
    expect(useStagedChangesStore.getState().list('c2').map((c) => c.path)).toEqual(['b'])
  })

  it('remove drops a single entry and is a no-op for unknown ids', () => {
    const id = useStagedChangesStore.getState().stage('c1', {
      path: 'a',
      oldContent: '',
      newContent: 'x',
      diff: '',
    })
    useStagedChangesStore.getState().remove('c1', 'nonexistent-id')
    expect(useStagedChangesStore.getState().list('c1')).toHaveLength(1)
    useStagedChangesStore.getState().remove('c1', id)
    expect(useStagedChangesStore.getState().list('c1')).toEqual([])
  })

  it('clear empties a chat queue without touching others', () => {
    useStagedChangesStore.getState().stage('c1', {
      path: 'a',
      oldContent: '',
      newContent: 'x',
      diff: '',
    })
    useStagedChangesStore.getState().stage('c2', {
      path: 'b',
      oldContent: '',
      newContent: 'y',
      diff: '',
    })
    useStagedChangesStore.getState().clear('c1')
    expect(useStagedChangesStore.getState().list('c1')).toEqual([])
    expect(useStagedChangesStore.getState().list('c2')).toHaveLength(1)
  })

  it('clearing the last entry deletes the chat key entirely', () => {
    const id = useStagedChangesStore.getState().stage('c1', {
      path: 'a',
      oldContent: '',
      newContent: 'x',
      diff: '',
    })
    useStagedChangesStore.getState().remove('c1', id)
    expect(useStagedChangesStore.getState().byChat['c1']).toBeUndefined()
  })

  it('get returns the entry by id', () => {
    const id = useStagedChangesStore.getState().stage('c1', {
      path: 'a',
      oldContent: '',
      newContent: 'x',
      diff: '',
    })
    const found = useStagedChangesStore.getState().get('c1', id)
    expect(found?.path).toBe('a')
    expect(useStagedChangesStore.getState().get('c1', 'unknown')).toBeUndefined()
  })
})

// The queue holds approved work that is not on disk yet. It used to live in
// memory only, so a restart, and therefore every update, emptied it silently
// (Morgan, 2026-08-11). What comes back from disk is data, not trusted state.
describe('the queue survives a restart', () => {
  const NOW = 1_786_500_000_000
  const DAY = 24 * 60 * 60 * 1000
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    path: 'src/main.py',
    resolvedPath: '/proj/src/main.py',
    oldContent: 'before',
    newContent: 'after',
    diff: '',
    stagedAt: NOW - DAY,
    ...over,
  })

  it('keeps a pending change that is still recent', () => {
    const out = pruneStagedQueues({ c1: [entry()] }, NOW)
    expect(out.c1).toHaveLength(1)
    expect(out.c1[0].newContent).toBe('after')
  })

  it('drops what a project has long moved past, and empty chats with it', () => {
    const out = pruneStagedQueues(
      { c1: [entry({ stagedAt: NOW - 15 * DAY })], c2: [entry({ id: 'e2' })] },
      NOW,
    )
    expect(out.c1).toBeUndefined()
    expect(out.c2).toHaveLength(1)
  })

  it('keeps an entry whose age cannot be read, losing work is the worse failure', () => {
    const out = pruneStagedQueues({ c1: [entry({ stagedAt: undefined })] }, NOW)
    expect(out.c1).toHaveLength(1)
  })

  it('ignores anything that is not a staged change', () => {
    expect(pruneStagedQueues(undefined, NOW)).toEqual({})
    expect(pruneStagedQueues({ c1: 'not an array' }, NOW)).toEqual({})
    expect(pruneStagedQueues({ c1: [null, 42, { id: 'x' }] }, NOW)).toEqual({})
    // A record with the right shape but no content is not a change either.
    expect(pruneStagedQueues({ c1: [{ id: 'x', path: 'a' }] }, NOW)).toEqual({})
  })

  it('writes to IndexedDB through the coalescing wrapper, never to localStorage', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, '../stagedChangesStore.ts'), 'utf8')
    // An entry carries the file twice, so the ~5 MB localStorage cap is not an
    // option, and a write per set() is what took the renderer's memory out on
    // 2026-08-03.
    expect(src).toMatch(/coalescedJSONStorage<StagedChangesState>\(idbStorage\)/)
    // The word appears in the comment explaining why; the API must not.
    expect(src).not.toMatch(/localStorage\s*[.[]/)
    expect(src).toMatch(/export function flushStagedPersist/)
  })
})
