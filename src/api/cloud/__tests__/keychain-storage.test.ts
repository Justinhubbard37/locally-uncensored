/**
 * The keychain-backed session storage adapter (src/api/cloud/supabase.ts).
 *
 * This adapter holds the LU Cloud refresh token. It was completely untested,
 * and the invariants it relies on are all written as prose in the comments —
 * so this file asserts them instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const secretGet = vi.fn()
const secretSet = vi.fn()
const secretDelete = vi.fn()

vi.mock('../../backend', () => ({
  secretGet: (...a: unknown[]) => secretGet(...a),
  secretSet: (...a: unknown[]) => secretSet(...a),
  secretDelete: (...a: unknown[]) => secretDelete(...a),
  oauthStart: vi.fn(),
  oauthWait: vi.fn(),
  openExternal: vi.fn(),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }))
vi.mock('../config', () => ({ SUPABASE_URL: 'https://x.test', SUPABASE_ANON_KEY: 'anon' }))

// vitest runs in the node environment here, so the adapter's localStorage
// fallback needs a stand-in.
const memory = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
})

const SESSION = 'lu-cloud-session'
const VERIFIER = 'lu-cloud-session-code-verifier'

async function freshAdapter() {
  vi.resetModules()
  localStorage.clear()
  secretGet.mockReset()
  secretSet.mockReset()
  secretDelete.mockReset()
  secretGet.mockResolvedValue(null)
  secretSet.mockResolvedValue(undefined)
  secretDelete.mockResolvedValue(undefined)
  const mod = await import('../supabase')
  return mod.keychainStorage
}

beforeEach(() => {
  localStorage.clear()
})

describe('a healthy keychain keeps the token out of localStorage', () => {
  it('writes to the keychain and drops any stale localStorage copy', async () => {
    const store = await freshAdapter()
    localStorage.setItem(SESSION, 'stale-from-an-earlier-fallback')

    await store.setItem(SESSION, 'fresh')

    expect(secretSet).toHaveBeenCalledWith(SESSION, 'fresh')
    expect(localStorage.getItem(SESSION)).toBeNull()
  })

  it('gives the PKCE verifier its own account so it cannot clobber the session', async () => {
    const store = await freshAdapter()
    await store.setItem(SESSION, 'session-value')
    await store.setItem(VERIFIER, 'verifier-value')

    const accounts = secretSet.mock.calls.map((c) => c[0])
    expect(new Set(accounts).size).toBe(2)
    expect(accounts).toContain(SESSION)
  })
})

describe('a transient keychain failure must not latch', () => {
  it('falls back for that call only and retries the keychain next time', async () => {
    const store = await freshAdapter()
    secretSet.mockRejectedValueOnce(new Error('user cancelled the unlock prompt'))

    await store.setItem(SESSION, 'first')
    expect(localStorage.getItem(SESSION)).toBe('first')

    secretSet.mockResolvedValue(undefined)
    await store.setItem(SESSION, 'second')
    expect(secretSet).toHaveBeenLastCalledWith(SESSION, 'second')
    expect(localStorage.getItem(SESSION)).toBeNull()
  })

  it('a permanent absence latches so later calls skip the keychain entirely', async () => {
    const store = await freshAdapter()
    secretSet.mockRejectedValue(new Error('keychain unsupported on this platform'))

    await store.setItem(SESSION, 'first')
    const callsAfterFirst = secretSet.mock.calls.length
    await store.setItem(SESSION, 'second')

    expect(secretSet.mock.calls.length).toBe(callsAfterFirst)
    expect(localStorage.getItem(SESSION)).toBe('second')
  })

  it('prefers a localStorage fallback copy over the older keychain value', async () => {
    const store = await freshAdapter()
    secretGet.mockResolvedValue('older-keychain-value')
    localStorage.setItem(SESSION, 'newer-fallback-value')

    await expect(store.getItem(SESSION)).resolves.toBe('newer-fallback-value')
  })
})

describe('sign-out must not leave a resurrectable session', () => {
  it('clears both stores on a healthy keychain', async () => {
    const store = await freshAdapter()
    localStorage.setItem(SESSION, 'fallback-copy')

    await store.removeItem(SESSION)

    expect(secretDelete).toHaveBeenCalledWith(SESSION)
    expect(localStorage.getItem(SESSION)).toBeNull()
  })

  it('does not report success when the keychain entry survived', async () => {
    const store = await freshAdapter()
    // Not "keychain unavailable"/"unsupported" — the keychain is THERE and the
    // delete failed anyway (locked at wake, dismissed prompt, CredMan hiccup).
    // The refresh token is still in it, so the next launch signs the user back
    // in. Silently resolving here reports a sign-out that did not happen.
    secretDelete.mockRejectedValue(new Error('The stub received bad data.'))

    await expect(store.removeItem(SESSION)).rejects.toThrow()
    expect(localStorage.getItem(SESSION)).toBeNull()
  })

  it('neutralises the surviving entry so the next launch cannot restore it', async () => {
    const store = await freshAdapter()
    secretDelete.mockRejectedValue(new Error('The stub received bad data.'))

    await store.removeItem(SESSION).catch(() => {})

    // Best effort: a write may succeed where the delete did not.
    expect(secretSet).toHaveBeenCalledWith(SESSION, expect.any(String))
    const tombstone = secretSet.mock.calls[0][1]

    // Next launch: the entry is physically there, but must read as signed out.
    secretGet.mockResolvedValue(tombstone)
    await expect(store.getItem(SESSION)).resolves.toBeNull()
  })

  it('a real session still reads back normally', async () => {
    const store = await freshAdapter()
    secretGet.mockResolvedValue('{"access_token":"abc"}')
    await expect(store.getItem(SESSION)).resolves.toBe('{"access_token":"abc"}')
  })
})
