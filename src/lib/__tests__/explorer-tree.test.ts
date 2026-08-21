/**
 * The Explorer tree (2.6.6 C3): lazy per node, jailed to the picked root,
 * ignore filter, and a listing that admits when the backend cut it off.
 *
 * The three claims that matter, each with its counter-test:
 *   1. Expanding a folder lists THAT folder and nothing else (lazy).
 *   2. Expanding never moves the jail: every call carries the picked root as
 *      workingDirectory, which is exactly what the old panel got wrong.
 *   3. A path outside the root is refused before the backend is asked.
 *
 * Run: npx vitest run src/lib/__tests__/explorer-tree.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import {
  EXPLORER_IGNORED,
  FS_LIST_CAP,
  flattenTree,
  isIgnoredEntry,
  isWithinRoot,
  loadChildren,
  parseListing,
  toggleExpanded,
  type ExplorerListing,
} from '../explorer-tree'

const ROOT = '/repo'

const entry = (dir: string, name: string, isDir = false) => ({
  name,
  path: `${dir}/${name}`,
  isDir,
  size: 12,
  modified: 0,
})

/** A stand-in for the fs_list backend command. */
function fakeBackend(dirs: Record<string, unknown[]>) {
  const calls: Array<{ path: string; workingDirectory: string; recursive: boolean }> = []
  const fsList = vi.fn(async (args: { path: string; recursive: boolean; pattern: null; workingDirectory: string }) => {
    calls.push({ path: args.path, workingDirectory: args.workingDirectory, recursive: args.recursive })
    const entries = dirs[args.path]
    if (!entries) throw new Error(`Not a directory: ${args.path}`)
    return { entries, count: entries.length }
  })
  return { fsList, calls }
}

const REPO = {
  '/repo': [entry('/repo', 'src', true), entry('/repo', 'node_modules', true), entry('/repo', 'README.md')],
  '/repo/src': [entry('/repo/src', 'lib', true), entry('/repo/src', 'main.ts')],
  '/repo/src/lib': [entry('/repo/src/lib', 'util.ts')],
}

describe('expanding a folder loads it lazily', () => {
  it('lists only the root until a folder is expanded', async () => {
    const { fsList, calls } = fakeBackend(REPO)
    const listings: Record<string, ExplorerListing> = {}
    listings[ROOT] = await loadChildren(ROOT, ROOT, fsList)

    expect(calls.map((c) => c.path)).toEqual(['/repo'])
    // src is visible but has no children yet, so the tree is one level deep.
    const rows = flattenTree(ROOT, listings, [])
    expect(rows.map((r) => r.node.name)).toEqual(['src', 'README.md'])
    expect(rows.every((r) => r.depth === 0)).toBe(true)
  })

  it('fetches a folder exactly once, when it is opened', async () => {
    const { fsList, calls } = fakeBackend(REPO)
    const listings: Record<string, ExplorerListing> = {}
    listings[ROOT] = await loadChildren(ROOT, ROOT, fsList)

    const expanded = toggleExpanded([], '/repo/src')
    listings['/repo/src'] = await loadChildren('/repo/src', ROOT, fsList)

    expect(calls.map((c) => c.path)).toEqual(['/repo', '/repo/src'])
    const rows = flattenTree(ROOT, listings, expanded)
    expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      '0:src',
      '1:lib',
      '1:main.ts',
      '0:README.md',
    ])
    // The deeper folder is still untouched: lazy means lazy.
    expect(calls.some((c) => c.path === '/repo/src/lib')).toBe(false)
  })

  it('collapsing hides the children again without re-fetching', async () => {
    const { fsList, calls } = fakeBackend(REPO)
    const listings: Record<string, ExplorerListing> = {}
    listings[ROOT] = await loadChildren(ROOT, ROOT, fsList)
    listings['/repo/src'] = await loadChildren('/repo/src', ROOT, fsList)

    const closed = toggleExpanded(['/repo/src'], '/repo/src')
    expect(closed).toEqual([])
    expect(flattenTree(ROOT, listings, closed).map((r) => r.node.name)).toEqual(['src', 'README.md'])
    expect(calls).toHaveLength(2)
  })

  it('counter-test: an unloaded folder contributes no rows even when marked open', () => {
    const listings: Record<string, ExplorerListing> = {
      [ROOT]: parseListing({ entries: REPO['/repo'] }),
    }
    const rows = flattenTree(ROOT, listings, ['/repo/src'])
    expect(rows.map((r) => r.node.name)).toEqual(['src', 'README.md'])
  })
})

describe('the jail stays where the user put it', () => {
  it('carries the picked root as workingDirectory for every node', async () => {
    const { fsList, calls } = fakeBackend(REPO)
    await loadChildren(ROOT, ROOT, fsList)
    await loadChildren('/repo/src', ROOT, fsList)
    await loadChildren('/repo/src/lib', ROOT, fsList)

    // The old panel passed the clicked folder here, which moved the agent's
    // workspace root on every browse click.
    expect(calls.map((c) => c.workingDirectory)).toEqual(['/repo', '/repo', '/repo'])
    expect(calls.every((c) => c.recursive === false)).toBe(true)
  })

  it('refuses a path outside the root without asking the backend', async () => {
    const { fsList, calls } = fakeBackend({ ...REPO, '/etc': [entry('/etc', 'passwd')] })
    await expect(loadChildren('/etc', ROOT, fsList)).rejects.toThrow(/outside the workspace root/)
    await expect(loadChildren('/repo/../etc', ROOT, fsList)).rejects.toThrow(/outside/)
    expect(calls).toHaveLength(0)
  })

  it('drops entries that point out of the root', async () => {
    const { fsList } = fakeBackend({
      '/repo': [
        entry('/repo', 'src', true),
        { name: 'escape', path: '/etc/shadow', isDir: false, size: 1, modified: 0 },
      ],
    })
    const listing = await loadChildren(ROOT, ROOT, fsList)
    expect(listing.nodes.map((n) => n.name)).toEqual(['src'])
  })

  it('isWithinRoot: the root itself and its children pass, look-alikes do not', () => {
    expect(isWithinRoot('/repo', '/repo')).toBe(true)
    expect(isWithinRoot('/repo', '/repo/src/main.ts')).toBe(true)
    expect(isWithinRoot('/repo', '/repo-evil/main.ts')).toBe(false)
    expect(isWithinRoot('/repo', '/etc/passwd')).toBe(false)
    expect(isWithinRoot('/repo', '/repo/../etc/passwd')).toBe(false)
    expect(isWithinRoot('', '/repo/a')).toBe(false)
    expect(isWithinRoot('/repo', '')).toBe(false)
  })

  it('isWithinRoot speaks Windows: backslashes and case', () => {
    expect(isWithinRoot('D:\\Projects\\site', 'D:\\Projects\\site\\src\\main.rs')).toBe(true)
    expect(isWithinRoot('D:\\Projects\\site', 'D:/Projects/Site/src/main.rs')).toBe(true)
    expect(isWithinRoot('D:\\Projects\\site', 'D:\\Projects\\other\\x.txt')).toBe(false)
    expect(isWithinRoot('D:\\Projects\\site', 'D:\\Projects\\site\\..\\other\\x.txt')).toBe(false)
    // A POSIX root stays case-sensitive: /repo and /REPO are two folders.
    expect(isWithinRoot('/repo', '/REPO/a.txt')).toBe(false)
  })
})

describe('the ignore filter', () => {
  it('hides exactly the four heavy folders', () => {
    expect([...EXPLORER_IGNORED].sort()).toEqual(['.git', 'dist', 'node_modules', 'target'])
    for (const name of EXPLORER_IGNORED) expect(isIgnoredEntry(name)).toBe(true)
  })

  it('counter-test: a name that merely starts the same is kept', () => {
    expect(isIgnoredEntry('node_modules.md')).toBe(false)
    expect(isIgnoredEntry('distribution')).toBe(false)
    expect(isIgnoredEntry('.gitignore')).toBe(false)
    expect(isIgnoredEntry('targets')).toBe(false)
  })

  it('takes them out of a listing and counts what it hid', () => {
    const listing = parseListing({
      entries: [
        entry('/repo', 'node_modules', true),
        entry('/repo', '.git', true),
        entry('/repo', 'dist', true),
        entry('/repo', 'target', true),
        entry('/repo', 'src', true),
        entry('/repo', '.gitignore'),
      ],
    })
    expect(listing.nodes.map((n) => n.name)).toEqual(['src', '.gitignore'])
    expect(listing.hidden).toBe(4)
  })

  it('puts folders first and sorts by name', () => {
    const listing = parseListing({
      entries: [
        entry('/repo', 'zeta.ts'),
        entry('/repo', 'alpha.ts'),
        entry('/repo', 'src', true),
        entry('/repo', 'Assets', true),
      ],
    })
    expect(listing.nodes.map((n) => n.name)).toEqual(['Assets', 'src', 'alpha.ts', 'zeta.ts'])
  })
})

describe('the 500 cap is visible', () => {
  it('flags a listing that came back at the cap', () => {
    const entries = Array.from({ length: FS_LIST_CAP }, (_, i) => entry('/repo', `f${i}.txt`))
    expect(parseListing({ entries }).truncated).toBe(true)
  })

  it('counter-test: one entry short of the cap is not flagged', () => {
    const entries = Array.from({ length: FS_LIST_CAP - 1 }, (_, i) => entry('/repo', `f${i}.txt`))
    expect(parseListing({ entries }).truncated).toBe(false)
  })

  it('survives a junk answer instead of guessing', () => {
    expect(parseListing(null)).toEqual({ nodes: [], truncated: false, hidden: 0 })
    expect(parseListing({ entries: 'nope' })).toEqual({ nodes: [], truncated: false, hidden: 0 })
    expect(parseListing({ entries: [{ name: '', path: '' }, { path: '/repo/x' }] }).nodes).toEqual([])
  })
})

describe('flattenTree', () => {
  it('cannot loop on a folder that contains itself (symlink)', () => {
    const listings: Record<string, ExplorerListing> = {
      '/repo': parseListing({ entries: [entry('/repo', 'self', true)] }),
      '/repo/self': parseListing({ entries: [{ name: 'self', path: '/repo/self', isDir: true }] }),
    }
    const rows = flattenTree('/repo', listings, ['/repo/self'])
    expect(rows.length).toBeLessThan(5)
  })
})
