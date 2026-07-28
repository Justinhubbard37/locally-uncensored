/**
 * Read-your-writes overlay for Stage-and-Approve — the fix for Morgan's loop
 * (2026-07-26): staged writes were invisible to file_read, so the model
 * re-read stale disk bytes, concluded the write failed, and staged the same
 * file forever.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeStagedPath,
  findStagedForPath,
  stagedReadResult,
  stagedListingNote,
} from '../staged-overlay'
import type { StagedChange } from '../../stores/stagedChangesStore'

const change = (over: Partial<StagedChange>): StagedChange => ({
  id: 'id-1',
  path: 'gui.py',
  oldContent: '',
  newContent: 'print("hi")\n',
  diff: '',
  stagedAt: 0,
  ...over,
})

describe('normalizeStagedPath', () => {
  it('strips ./, unifies slashes, drops trailing slash', () => {
    expect(normalizeStagedPath('./src/gui.py')).toBe('src/gui.py')
    expect(normalizeStagedPath('src\\gui.py')).toBe('src/gui.py')
    expect(normalizeStagedPath('src/dir/')).toBe('src/dir')
  })

  it('compares Windows drive paths case-insensitively, Unix paths not', () => {
    expect(normalizeStagedPath('C:\\Proj\\GUI.py')).toBe('c:/proj/gui.py')
    expect(normalizeStagedPath('/home/User/GUI.py')).toBe('/home/User/GUI.py')
  })
})

describe('findStagedForPath', () => {
  const list = [
    change({ id: '1', path: 'gui.py', resolvedPath: '/proj/wow-bot/gui.py' }),
    change({ id: '2', path: 'src/main.py' }),
  ]

  it('matches the path the model wrote with', () => {
    expect(findStagedForPath(list, 'gui.py')?.id).toBe('1')
    expect(findStagedForPath(list, './src/main.py')?.id).toBe('2')
  })

  it('matches the workspace-resolved absolute path too', () => {
    expect(findStagedForPath(list, '/proj/wow-bot/gui.py')?.id).toBe('1')
  })

  it('returns undefined for unknown or empty paths', () => {
    expect(findStagedForPath(list, 'other.py')).toBeUndefined()
    expect(findStagedForPath(list, '')).toBeUndefined()
  })
})

describe('stagedReadResult / stagedListingNote', () => {
  it('serves the staged content first, with a pending marker', () => {
    const out = stagedReadResult(change({ newContent: 'CONTENT-42' }))
    expect(out.startsWith('CONTENT-42')).toBe(true)
    expect(out).toMatch(/NOT on disk yet/)
  })

  it('lists every pending path once, and is empty without staged changes', () => {
    const note = stagedListingNote([
      change({ id: '1', path: 'gui.py' }),
      change({ id: '2', path: 'main.py' }),
    ])
    expect(note).toContain('gui.py')
    expect(note).toContain('main.py')
    expect(note).toMatch(/pending user approval/)
    expect(stagedListingNote([])).toBe('')
  })
})
