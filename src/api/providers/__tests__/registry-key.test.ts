/**
 * Registry API-key handling — the store keeps keys obfuscated in memory;
 * getProvider must hand the REAL key to the client. Regression test for the
 * m9mx report (Discord 2026-07-26): Test button + chat sent a garbled Bearer
 * token, so Groq said "Invalid API Key" and OpenRouter chat 401ed while its
 * public /models let the Test button claim "connected".
 * Run: npx vitest run src/api/providers/__tests__/registry-key.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useProviderStore } from '../../../stores/providerStore'
import { getProvider, clearProviderCache } from '../registry'

const REAL_KEY = 'sk-or-real-key-123456'

describe('getProvider api key', () => {
  beforeEach(() => {
    clearProviderCache()
    useProviderStore.getState().setProviderConfig('openai', {
      enabled: true,
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      isLocal: false,
      managed: false,
    })
    useProviderStore.getState().setProviderApiKey('openai', REAL_KEY)
  })

  it('store holds the key obfuscated in memory (test premise)', () => {
    const raw = useProviderStore.getState().providers['openai'].apiKey
    expect(raw).not.toBe(REAL_KEY)
    expect(useProviderStore.getState().getProviderApiKey('openai')).toBe(REAL_KEY)
  })

  it('checkConnection sends the deobfuscated key as Bearer token', async () => {
    let seenAuth: string | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seenAuth = (init?.headers as Record<string, string> | undefined)?.['Authorization']
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }))

    const ok = await getProvider('openai').checkConnection()
    expect(ok).toBe(true)
    expect(seenAuth).toBe(`Bearer ${REAL_KEY}`)

    vi.unstubAllGlobals()
  })

  it('a key change invalidates the cached client', async () => {
    const seen: Array<string | undefined> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.['Authorization'])
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }))

    await getProvider('openai').checkConnection()
    useProviderStore.getState().setProviderApiKey('openai', 'sk-rotated-999')
    await getProvider('openai').checkConnection()
    expect(seen).toEqual([`Bearer ${REAL_KEY}`, 'Bearer sk-rotated-999'])

    vi.unstubAllGlobals()
  })
})
