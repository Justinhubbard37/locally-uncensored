/**
 * A dropped document was accepted and then never embedded.
 *
 * Measured on the Windows box on 2026-08-15 against the installed 2.6.5:
 * built-in engine active, the app models dir holding exactly one GGUF
 * (Hermes-3-Llama-3.2-3B, a chat model), ports 8127 and 8128 both dead. The
 * TXT went in without a word of protest and the panel then said
 * `Embedding failed (HTTP 500): proxy_localhost: error sending request`.
 *
 * Two separate defects met there:
 *
 *  1. The pre-flight asked the wrong question. It treated "the built-in engine
 *     is the active backend" as "the bundled lane can embed", but that lane
 *     needs an embedding GGUF, and `ensureBundledEmbedAlive` can only START
 *     one, never conjure it. Ollama on the same box HAD nomic-embed-text
 *     pulled, which is why the second half of the pre-flight would have said
 *     yes as well: rag.ts never asks Ollama once the built-in engine is on.
 *  2. When it failed anyway, the message named the pipe instead of the missing
 *     part. A transport error is not an explanation a user can act on.
 *
 * Run: npx vitest run src/api/__tests__/embed-lane-readiness.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let running = false
let bundled: { name: string; path: string }[] = []

vi.mock('../backend', () => ({
  backendCall: async (cmd: string) => {
    if (cmd === 'bundled_embed_status') return { running, healthy: running }
    if (cmd === 'list_bundled_models') return { dir: 'C:/models', models: bundled }
    return null
  },
  localFetch: async () => new Response('{}', { status: 200 }),
  ollamaUrl: (p: string) => `http://localhost:11434/api${p}`,
  isTauri: () => false,
}))

import { bundledEmbedLaneReady } from '../engine'

describe('the bundled lane knows whether it can embed', () => {
  beforeEach(() => {
    running = false
    bundled = []
  })

  it('says no when the only installed GGUF is a chat model', async () => {
    // The exact box state on 2026-08-15.
    bundled = [{ name: 'Hermes-3-Llama-3.2-3B-Q4_K_M.gguf', path: 'C:/models/Hermes-3.gguf' }]
    expect(await bundledEmbedLaneReady()).toBe(false)
  })

  it('says no when nothing is installed at all', async () => {
    expect(await bundledEmbedLaneReady()).toBe(false)
  })

  it('says yes when an embedding GGUF is installed, even with the server down', async () => {
    // ensureBundledEmbedAlive can start this one, so the lane is serviceable.
    bundled = [{ name: 'nomic-embed-text-v1.5.Q4_K_M.gguf', path: 'C:/models/nomic.gguf' }]
    expect(await bundledEmbedLaneReady()).toBe(true)
  })

  it('says yes when the server is already running, whatever is on disk', async () => {
    running = true
    expect(await bundledEmbedLaneReady()).toBe(true)
  })
})
