/**
 * Streamed tool-call assembly across OpenAI-compat servers (2026-07-28)
 *
 * LU talks to whatever OpenAI-compatible backend the user points it at, and
 * they do not all stream tool calls the way OpenAI does: the id can arrive a
 * chunk late, the name can arrive with the arguments, and `index` — required by
 * the spec — is sometimes missing entirely. The accumulator only ever read id
 * and name from the FIRST delta, so those servers produced a call with an empty
 * name (nothing to dispatch) or an empty tool_call_id (422 on the next turn).
 *
 * Run: npx vitest run src/api/__tests__/provider-toolcall-deltas.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIProvider } from '../providers/openai-provider'
import type { ProviderConfig, ChatStreamChunk } from '../providers/types'

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'openai',
    name: 'TestProvider',
    enabled: true,
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'test-key',
    isLocal: false,
    ...overrides,
  }
}

function sseResponse(events: string[]): Response {
  return new Response(events.map(e => `data: ${e}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

async function toolCallsFrom(events: string[]) {
  const provider = new OpenAIProvider(makeConfig())
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(events))
  const chunks: ChatStreamChunk[] = []
  for await (const c of provider.chatStream('m', [{ role: 'user', content: 'hi' }])) chunks.push(c)
  return chunks.find(c => c.done)?.toolCalls ?? []
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('streamed tool calls', () => {
  it('assembles the OpenAI shape (id + name up front, arguments in pieces)', async () => {
    const calls = await toolCallsFrom([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"file_read","arguments":""}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}',
      '[DONE]',
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('call_a')
    expect(calls[0].function.name).toBe('file_read')
    expect(calls[0].function.arguments).toEqual({ path: 'a.txt' })
  })

  it('keeps an id that only arrives in a later delta', async () => {
    const calls = await toolCallsFrom([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"shell_execute"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_late","function":{"arguments":"{}"}}]}}]}',
      '[DONE]',
    ])
    expect(calls[0].id).toBe('call_late')
    expect(calls[0].function.name).toBe('shell_execute')
  })

  it('keeps a name that only arrives in a later delta', async () => {
    const calls = await toolCallsFrom([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b"}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"web_search","arguments":"{\\"q\\":\\"x\\"}"}}]}}]}',
      '[DONE]',
    ])
    expect(calls[0].function.name).toBe('web_search')
    expect(calls[0].function.arguments).toEqual({ q: 'x' })
  })

  it('does not double a name that every delta repeats', async () => {
    const calls = await toolCallsFrom([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"file_write","arguments":"{"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file_write","arguments":"}"}}]}}]}',
      '[DONE]',
    ])
    expect(calls[0].function.name).toBe('file_write')
  })

  it('assembles a call from deltas that carry no index at all', async () => {
    const calls = await toolCallsFrom([
      '{"choices":[{"delta":{"tool_calls":[{"id":"call_x","function":{"name":"file_list","arguments":"{\\"p"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"ath\\":\\".\\"}"}}]}}]}',
      '[DONE]',
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('call_x')
    expect(calls[0].function.arguments).toEqual({ path: '.' })
  })

  it('keeps two index-less calls apart by their ids', async () => {
    const calls = await toolCallsFrom([
      '{"choices":[{"delta":{"tool_calls":[{"id":"one","function":{"name":"a","arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"id":"two","function":{"name":"b","arguments":"{}"}}]}}]}',
      '[DONE]',
    ])
    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.function.name)).toEqual(['a', 'b'])
  })

  it('never hands back an empty tool_call_id', async () => {
    const calls = await toolCallsFrom([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file_read","arguments":"{}"}}]}}]}',
      '[DONE]',
    ])
    expect(calls[0].id).toBeTruthy()
  })
})
