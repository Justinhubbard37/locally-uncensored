/**
 * Which IndexedDB-backed stores need to be put back from the appData backup.
 *
 * aldrich_ironhart, 2.6.5, Discord #general 18.08.: "has anyone lost their
 * chats after a restart??", then "My code chats are vaporised".
 *
 * LU keeps chat-conversations and locally-uncensored-memory in IndexedDB
 * (2.5.0, the 5 MB localStorage cap could not hold a real history) and every
 * other store in localStorage. Those are different storage layers with
 * different lifetimes: a hard process kill mid write, which is what a self
 * update does, can leave Chromium discarding the whole IndexedDB database on
 * the next start while localStorage comes back untouched.
 *
 * AppShell's restore only ever asked localStorage. On that boot every
 * localStorage store answers, so it took the quiet branch, restored RAG chunks
 * and returned. Nothing looked at IndexedDB, so the chats stayed gone with a
 * good copy of them sitting in store_backup.json the whole time.
 *
 * Pure so the decision can be proven without a webview: the caller reads the
 * live stores and the backup, this says what to write back.
 */

/** Never restore over something the live store still has. A shorter live
 *  value is not evidence of anything (a user can delete chats), so the only
 *  case that counts is a live store with nothing in it at all. */
function isEmpty(value: string | null | undefined): boolean {
  return !value || value.trim() === ''
}

/**
 * Keys that are empty in the live store and present in the backup.
 *
 * @param live    what idbStorage answered for each key, null when absent
 * @param backup  the parsed store_backup.json, or null when there is none
 */
export function idbKeysToRestore(
  live: Record<string, string | null>,
  backup: Record<string, unknown> | null,
): string[] {
  if (!backup) return []
  return Object.keys(live).filter((key) => {
    if (!isEmpty(live[key])) return false
    const saved = backup[key]
    return typeof saved === 'string' && !isEmpty(saved)
  })
}

/**
 * A hydrated store cannot pick the restored value up on its own, so the caller
 * reloads. That must happen at most once per window session: an IndexedDB that
 * refuses every write would otherwise restore, reload, find nothing, and go
 * round again forever.
 */
export const IDB_RESTORE_ONCE_KEY = 'lu-idb-restored'

export function mayReloadForIdbRestore(session: Pick<Storage, 'getItem' | 'setItem'> | null): boolean {
  if (!session) return false
  try {
    if (session.getItem(IDB_RESTORE_ONCE_KEY)) return false
    session.setItem(IDB_RESTORE_ONCE_KEY, '1')
    return true
  } catch {
    // No sessionStorage means no way to remember, and a reload loop is worse
    // than a boot that shows the restored chats only after the next start.
    return false
  }
}
