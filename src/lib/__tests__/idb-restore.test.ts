/**
 * DATA LOSS, aldrich_ironhart on 2.6.5, Discord #general 18.08.:
 * 12:59 "Uhhh guys, has anyone lost their chats after a restart??",
 * 16:12 "My code chats are vaporised" (a coding chat around 230k tokens).
 * sockenmonster on the same build still had every chat, weeks old ones
 * included, so this is not a plain regression in how LU writes.
 *
 * chat-conversations and locally-uncensored-memory live in IndexedDB (2.5.0,
 * the 5 MB localStorage cap could not hold a real history). Everything else
 * lives in localStorage. Two storage layers, two lifetimes: a hard process
 * kill mid write, which is what a self update does, can leave Chromium
 * discarding the whole IndexedDB database on the next start while
 * localStorage comes back untouched.
 *
 * AppShell's restore only ever asked localStorage. On that boot every
 * localStorage store answers, so it took the quiet branch, restored RAG
 * chunks, and returned. Nothing looked at IndexedDB. The chats stayed gone
 * with a good copy of them sitting in store_backup.json the whole time, and
 * the backup triad then wrote the empty state over it (the second half of
 * this fix lives in Rust, backup_stores).
 *
 * Run: npx vitest run src/lib/__tests__/idb-restore.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { idbKeysToRestore, mayReloadForIdbRestore, IDB_RESTORE_ONCE_KEY } from '../idb-restore'

const CHATS = 'chat-conversations'
const MEM = 'locally-uncensored-memory'

describe('deciding what to put back after an IndexedDB wipe', () => {
  it('names the store that is gone while the backup still has it', () => {
    // aldrich's boot: localStorage whole, IndexedDB empty, backup intact.
    const live = { [CHATS]: null, [MEM]: null }
    const backup = { __ts: 'yesterday', [CHATS]: '{"state":{"conversations":[1]}}', [MEM]: '{"state":{}}' }
    expect(idbKeysToRestore(live, backup).sort()).toEqual([CHATS, MEM])
  })

  it('never writes over a store that still has something', () => {
    // The ordinary boot, which is every boot but one. Restoring here would
    // roll a live store back to whatever the last backup happened to hold.
    const live = { [CHATS]: '{"state":{"conversations":[1,2,3]}}', [MEM]: null }
    const backup = { [CHATS]: '{"state":{"conversations":[1]}}', [MEM]: '{"state":{}}' }
    expect(idbKeysToRestore(live, backup)).toEqual([MEM])
  })

  it('a shorter live store is not a wiped one', () => {
    // Deleting chats is something people do on purpose. Only nothing at all
    // counts, never "less than the backup has".
    const live = { [CHATS]: '{"state":{"conversations":[]}}' }
    const backup = { [CHATS]: '{"state":{"conversations":[1,2,3]}}' }
    expect(idbKeysToRestore(live, backup)).toEqual([])
  })

  it('nothing to restore from is nothing to do', () => {
    expect(idbKeysToRestore({ [CHATS]: null }, null)).toEqual([])
    expect(idbKeysToRestore({ [CHATS]: null }, {})).toEqual([])
    expect(idbKeysToRestore({ [CHATS]: null }, { [CHATS]: '' })).toEqual([])
    expect(idbKeysToRestore({ [CHATS]: null }, { [CHATS]: '   ' })).toEqual([])
    // A backup value that is not a string cannot be handed to idbStorage.
    expect(idbKeysToRestore({ [CHATS]: null }, { [CHATS]: { conversations: [] } })).toEqual([])
  })

  it('NEGATIVE CONTROL: the old rule never asked IndexedDB at all', () => {
    // What AppShell decided on aldrich's boot: some localStorage store is
    // there and the restore sentinel is set, therefore nothing to restore.
    // Both true, and the chats were gone.
    const localStorageStores = { 'chat-settings': '{}', 'lu-providers': '{}' }
    const hasStores = Object.values(localStorageStores).some(Boolean)
    const restoreComplete = '1'
    expect(hasStores && !!restoreComplete).toBe(true)
    // The new question, on the same boot, has an answer.
    expect(idbKeysToRestore({ [CHATS]: null }, { [CHATS]: 'the chats' })).toEqual([CHATS])
  })
})

describe('the reload that makes a restored store visible', () => {
  function session() {
    const store: Record<string, string> = {}
    return {
      getItem: vi.fn((k: string) => store[k] ?? null),
      setItem: vi.fn((k: string, v: string) => { store[k] = v }),
    }
  }

  it('happens once, so a write that never lands cannot loop the app', () => {
    const s = session()
    expect(mayReloadForIdbRestore(s)).toBe(true)
    expect(s.setItem).toHaveBeenCalledWith(IDB_RESTORE_ONCE_KEY, '1')
    // Second boot of the same window session: the restore may run again, the
    // reload may not.
    expect(mayReloadForIdbRestore(s)).toBe(false)
  })

  it('no session storage means no reload, rather than an unbounded one', () => {
    expect(mayReloadForIdbRestore(null)).toBe(false)
    const broken = {
      getItem: () => null,
      setItem: () => { throw new Error('denied') },
    }
    expect(mayReloadForIdbRestore(broken)).toBe(false)
  })
})

describe('the wiring in AppShell', () => {
  it('asks IndexedDB before it releases the backup triad', async () => {
    // Order is the whole safety property: the triad's first doBackup reads the
    // live stores and writes them to store_backup.json. Released too early on
    // a wiped boot, it snapshots nothing over the only copy of the chats. The
    // file already guards the localStorage case with restoreDecided; this pins
    // that the IndexedDB case sits inside the same gate.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../components/layout/AppShell.tsx'),
      'utf8',
    )
    const ask = src.indexOf('idbKeysToRestore(live')
    const release = src.indexOf('resolveRestoreDecided()')
    expect(ask).toBeGreaterThan(-1)
    expect(release).toBeGreaterThan(ask)
    // And the reload is gated, not unconditional.
    expect(src).toContain('mayReloadForIdbRestore(')
  })
})
