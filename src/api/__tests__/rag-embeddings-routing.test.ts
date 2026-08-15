/**
 * P5 — Embeddings routing: Document-Chat/RAG must embed against the bundled
 * `llama-server --embeddings` (OpenAI `/v1/embeddings`) when the app-managed
 * built-in engine is active, and only fall back to Ollama's `/api/embed`
 * otherwise. This is the frontend half of "onboarding is Ollama-free".
 *
 * We mock the backend transport + the engine active-check so the pure routing
 * decision (which URL, which response shape) is testable without a real server.
 *
 * Run: npx vitest run src/api/__tests__/rag-embeddings-routing.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mutable flags the mock reads so each test can flip the active backend and
// whether the self-heal left a server behind.
let builtinActive = false
let embedRunning = true
const ensureEmbed = vi.fn()

vi.mock('../engine', () => ({
  isManagedBuiltinActive: () => builtinActive,
  embedBaseUrl: () => 'http://127.0.0.1:8128/v1',
  // Post-offload self-heal: rag awaits this before hitting :8128.
  ensureBundledEmbedAlive: (...args: any[]) => ensureEmbed(...args),
  bundledEmbedStatus: async () => ({ running: embedRunning, healthy: embedRunning }),
}))

const localFetch = vi.fn()
vi.mock('../backend', () => ({
  localFetch: (...args: any[]) => localFetch(...args),
  ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
}))

import { generateEmbeddings } from '../rag'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('generateEmbeddings routing', () => {
  beforeEach(() => {
    localFetch.mockReset()
    ensureEmbed.mockReset()
    builtinActive = false
    embedRunning = true
  })

  it('hits the bundled /v1/embeddings when the built-in engine is active', async () => {
    builtinActive = true
    // OpenAI shape, deliberately returned out of order to prove we sort by index.
    localFetch.mockResolvedValue(jsonResponse({
      data: [
        { index: 1, embedding: [0.3, 0.4] },
        { index: 0, embedding: [0.1, 0.2] },
      ],
    }))

    const out = await generateEmbeddings(['a', 'b'])

    const [url, opts] = localFetch.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8128/v1/embeddings')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body).input).toEqual(['a', 'b'])
    // Sorted back into input order.
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]])
    // The post-offload self-heal MUST run before the request — a Create render
    // stops the embed sidecar, and without this await RAG dies on a dead port.
    expect(ensureEmbed).toHaveBeenCalledTimes(1)
  })

  it('falls back to Ollama /api/embed when the built-in engine is NOT active', async () => {
    builtinActive = false
    // A running bundled server would win even here (LM Studio setups embed
    // through it), so this case only exists with the server down.
    embedRunning = false
    localFetch.mockResolvedValue(jsonResponse({ embeddings: [[0.9, 0.8]] }))

    const out = await generateEmbeddings(['x'])

    const [url] = localFetch.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/embed')
    expect(out).toEqual([[0.9, 0.8]])
  })

  it('names the missing model when the self-heal could not bring a server up', async () => {
    // The Windows box on 2026-08-15: built-in engine active, no embedding GGUF
    // installed, so ensureBundledEmbedAlive has nothing to start. Before this
    // the request went out anyway and came back as
    // `proxy_localhost: error sending request`, which names the pipe, not the
    // missing part. No request should leave at all in this state.
    builtinActive = true
    embedRunning = false

    await expect(generateEmbeddings(['a'])).rejects.toThrow(/No embedding model is installed/)
    expect(ensureEmbed).toHaveBeenCalledTimes(1)
    expect(localFetch).not.toHaveBeenCalled()
  })

  it('surfaces a built-in-specific error (not an Ollama hint) when the embed server fails', async () => {
    builtinActive = true
    localFetch.mockResolvedValue(jsonResponse({ error: { message: 'model still loading' } }, 503))

    await expect(generateEmbeddings(['a'])).rejects.toThrow(/model still loading/)
  })
})
