import { describe, it, expect } from 'vitest'
import { streamProviderTurn } from '../provider-stream'
import type { ChatStreamChunk, ProviderClient } from '../../api/providers/types'

function fakeProvider(chunks: ChatStreamChunk[]): ProviderClient {
  return {
    id: 'openai',
    async *chatStream() {
      for (const c of chunks) yield c
    },
    chatWithTools: async () => ({ content: '', toolCalls: [] }),
    listModels: async () => [],
    checkConnection: async () => true,
    getContextLength: async () => 8192,
  } as unknown as ProviderClient
}

describe('streamProviderTurn', () => {
  it('accumulates content deltas and reports cumulative text to the callback', async () => {
    const provider = fakeProvider([
      { content: 'Hel', done: false },
      { content: 'lo', done: false },
      { content: '', done: true, finishReason: 'stop' },
    ])
    const seen: string[] = []
    const turn = await streamProviderTurn(provider, 'm', [], {}, (full) => seen.push(full))
    expect(seen).toEqual(['Hel', 'Hello'])
    expect(turn.content).toBe('Hello')
    expect(turn.finishReason).toBe('stop')
    expect(turn.toolCalls).toEqual([])
  })

  it('hands the raw delta to the callback as second argument', async () => {
    const provider = fakeProvider([
      { content: 'a', done: false },
      { content: 'bc', done: false },
      { content: '', done: true },
    ])
    const deltas: string[] = []
    await streamProviderTurn(provider, 'm', [], {}, (_full, delta) => deltas.push(delta))
    expect(deltas).toEqual(['a', 'bc'])
  })

  it('collects tool calls and usage from the done chunk', async () => {
    const calls = [{ id: '1', function: { name: 'file_read', arguments: { path: 'a' } } }]
    const provider = fakeProvider([
      { content: 'ok', done: false },
      { content: '', done: true, toolCalls: calls, promptEvalCount: 120, evalCount: 34, finishReason: 'tool_calls' },
    ])
    const turn = await streamProviderTurn(provider, 'm', [], {})
    expect(turn.toolCalls).toEqual(calls)
    expect(turn.promptEvalCount).toBe(120)
    expect(turn.evalCount).toBe(34)
    expect(turn.finishReason).toBe('tool_calls')
  })

  it('accumulates thinking separately from content', async () => {
    const provider = fakeProvider([
      { content: '', thinking: 'hm', done: false },
      { content: '', thinking: 'm…', done: false },
      { content: 'answer', done: false },
      { content: '', done: true },
    ])
    const thinks: string[] = []
    const turn = await streamProviderTurn(provider, 'm', [], {}, undefined, (full) => thinks.push(full))
    expect(thinks).toEqual(['hm', 'hmm…'])
    expect(turn.thinking).toBe('hmm…')
    expect(turn.content).toBe('answer')
  })

  it('propagates a mid-stream error to the caller', async () => {
    const provider = {
      id: 'openai',
      // eslint-disable-next-line require-yield
      async *chatStream(): AsyncGenerator<ChatStreamChunk> {
        throw Object.assign(new Error('boom'), { statusCode: 500 })
      },
    } as unknown as ProviderClient
    await expect(streamProviderTurn(provider, 'm', [], {})).rejects.toThrow('boom')
  })
})
