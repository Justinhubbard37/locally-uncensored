/**
 * 2.6.6 A8: prompt caching for the Anthropic BYOK provider.
 *
 * Verified through the request body the provider actually puts on the wire,
 * not through internals. Three ephemeral breakpoints, in render order
 * (tools -> system -> messages): the last tool definition, the system block,
 * and the last STABLE history message. "Stable" is the youngest message the
 * next request will send unchanged, so the current turn is deliberately left
 * unmarked. The API caps breakpoints at 4; we must never exceed 3, so every
 * test that can counts them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnthropicProvider } from '../anthropic-provider'
import type { ChatMessage, ChatStreamChunk, ProviderConfig, ToolDefinition } from '../types'

const EPHEMERAL = { type: 'ephemeral' }

function makeConfig(): ProviderConfig {
  return {
    id: 'anthropic', name: 'Anthropic', enabled: true,
    baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-test', isLocal: false,
  }
}

function tool(name: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: `does ${name}`,
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    },
  }
}

/** Every JSON path in the body that carries a cache_control marker. */
function markerPaths(value: any, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => markerPaths(v, `${path}[${i}]`))
  }
  if (value && typeof value === 'object') {
    const here = 'cache_control' in value ? [path] : []
    return [
      ...here,
      ...Object.entries(value)
        .filter(([k]) => k !== 'cache_control')
        .flatMap(([k, v]) => markerPaths(v, `${path}.${k}`)),
    ]
  }
  return []
}

/** Non-streaming path (chatWithTools): capture every request body sent. */
function captureJson() {
  const bodies: any[] = []
  const headers: Record<string, string>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body))
    headers.push(init.headers)
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 9, output_tokens: 2 } }),
    } as any
  }))
  return { bodies, headers }
}

/** Streaming path (chatStream): capture bodies, answer with a minimal SSE turn. */
function captureSse() {
  const bodies: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body))
    return new Response(
      [
        'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":9,"output_tokens":1}}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      ].join(''),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  }))
  return { bodies }
}

async function drain(gen: AsyncGenerator<ChatStreamChunk>): Promise<void> {
  for await (const chunk of gen) { void chunk }
}

/** A conversation of `rounds` completed exchanges plus one fresh user turn. */
function conversation(rounds: number, withSystem = true): ChatMessage[] {
  const messages: ChatMessage[] = withSystem ? [{ role: 'system', content: 'SYSTEM PROMPT' }] : []
  for (let i = 1; i <= rounds; i++) {
    messages.push({ role: 'user', content: `question ${i}` })
    messages.push({ role: 'assistant', content: `answer ${i}` })
  }
  messages.push({ role: 'user', content: 'current turn' })
  return messages
}

afterEach(() => vi.unstubAllGlobals())

describe('A8 cache_control placement', () => {
  it('non-streaming request carries exactly three markers, at the three specified places', async () => {
    const { bodies } = captureJson()
    const provider = new AnthropicProvider(makeConfig())

    await provider.chatWithTools('claude-haiku-4-5-20251001', conversation(1), [tool('read'), tool('write')])
    const body = bodies[0]

    // 1. system block: string became a one-block array carrying the marker
    expect(body.system).toEqual([
      { type: 'text', text: 'SYSTEM PROMPT', cache_control: EPHEMERAL },
    ])
    // 2. LAST tool definition only
    expect(body.tools).toHaveLength(2)
    expect(body.tools[0].cache_control).toBeUndefined()
    expect(body.tools[1].name).toBe('write')
    expect(body.tools[1].cache_control).toEqual(EPHEMERAL)
    // 3. last stable message = the previous round's assistant turn
    expect(body.messages).toHaveLength(3)
    expect(body.messages[1].role).toBe('assistant')
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: 'answer 1', cache_control: EPHEMERAL },
    ])

    // The current turn stays unmarked: marking it would only ever write.
    expect(body.messages[2].content).toBe('current turn')

    expect(markerPaths(body).sort()).toEqual([
      '$.messages[1].content[0]',
      '$.system[0]',
      '$.tools[1]',
    ])
  })

  it('streaming request carries the same three markers', async () => {
    const { bodies } = captureSse()
    const provider = new AnthropicProvider(makeConfig())

    await drain(provider.chatStream('claude-haiku-4-5-20251001', conversation(1), {
      tools: [tool('read'), tool('write')],
    }))
    const body = bodies[0]

    expect(body.stream).toBe(true)
    expect(body.system[0].cache_control).toEqual(EPHEMERAL)
    expect(body.tools[1].cache_control).toEqual(EPHEMERAL)
    expect(body.messages[1].content[0].cache_control).toEqual(EPHEMERAL)
    expect(markerPaths(body)).toHaveLength(3)
  })

  it('a request without tools carries exactly two markers', async () => {
    const { bodies } = captureJson()
    const provider = new AnthropicProvider(makeConfig())

    await provider.chatWithTools('claude-haiku-4-5-20251001', conversation(1), [])
    const body = bodies[0]

    expect(body.tools).toBeUndefined()
    expect(markerPaths(body).sort()).toEqual([
      '$.messages[1].content[0]',
      '$.system[0]',
    ])
  })

  it('the history marker moves with the conversation and always sits on the second-to-last round', async () => {
    const { bodies } = captureJson()
    const provider = new AnthropicProvider(makeConfig())

    for (const rounds of [1, 2, 3, 7]) {
      await provider.chatWithTools('claude-haiku-4-5-20251001', conversation(rounds), [tool('read')])
    }

    const marked = bodies.map((b: any) => {
      const i = b.messages.length - 2
      return { index: i, total: b.messages.length, text: b.messages[i].content[0].text }
    })

    // rounds=1 -> 3 wire messages, rounds=2 -> 5, and so on: always index n-2,
    // always the assistant answer of the round before the current turn.
    expect(marked).toEqual([
      { index: 1, total: 3, text: 'answer 1' },
      { index: 3, total: 5, text: 'answer 2' },
      { index: 5, total: 7, text: 'answer 3' },
      { index: 13, total: 15, text: 'answer 7' },
    ])
    // The older rounds stay byte-stable and unmarked, so the prefix survives.
    for (const body of bodies) {
      expect(markerPaths(body)).toHaveLength(3)
      expect(body.messages[body.messages.length - 1].content).toBe('current turn')
    }
  })

  it('never exceeds three markers, well under the API limit of four', async () => {
    const { bodies } = captureJson()
    const provider = new AnthropicProvider(makeConfig())

    await provider.chatWithTools(
      'claude-haiku-4-5-20251001',
      conversation(20),
      ['a', 'b', 'c', 'd', 'e', 'f'].map(tool),
    )

    expect(markerPaths(bodies[0]).length).toBeLessThanOrEqual(4)
    expect(markerPaths(bodies[0])).toHaveLength(3)
  })

  it('a first turn has no stable history yet and carries no history marker', async () => {
    const { bodies } = captureJson()
    const provider = new AnthropicProvider(makeConfig())

    await provider.chatWithTools('claude-haiku-4-5-20251001', conversation(0), [])
    const body = bodies[0]

    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].content).toBe('current turn')
    expect(markerPaths(body)).toEqual(['$.system[0]'])
  })

  it('a bare request with neither system nor tools nor history carries no marker at all', async () => {
    const { bodies } = captureJson()
    const provider = new AnthropicProvider(makeConfig())

    await provider.chatWithTools('claude-haiku-4-5-20251001', [{ role: 'user', content: 'hi' }], [])

    expect(bodies[0].system).toBeUndefined()
    expect(markerPaths(bodies[0])).toEqual([])
  })

  it('the vision path carries the markers and never stamps an image block', async () => {
    const { bodies } = captureJson()
    const provider = new AnthropicProvider(makeConfig())

    const messages: ChatMessage[] = [
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'what is this?', images: [{ data: 'AAAA', mimeType: 'image/png' }] },
      { role: 'assistant', content: 'a car' },
      { role: 'user', content: 'and this?', images: [{ data: 'BBBB', mimeType: 'image/png' }] },
    ]
    await provider.chatWithTools('claude-haiku-4-5-20251001', messages, [tool('read')])
    const body = bodies[0]

    // The vision turn really is a block array, and no image block was stamped.
    expect(body.messages[0].content[0].type).toBe('image')
    expect(markerPaths(body)).toHaveLength(3)
    for (const path of markerPaths(body)) {
      expect(path).not.toMatch(/messages\[0\]/)
    }
    expect(body.messages[1].content[0].cache_control).toEqual(EPHEMERAL)
  })

  it('the agent tool path marks the settled tool_use turn, not the fresh tool results', async () => {
    const { bodies } = captureJson()
    const provider = new AnthropicProvider(makeConfig())

    const messages: ChatMessage[] = [
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'read both' },
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'toolu_1', function: { name: 'read', arguments: { path: 'a.ts' } } },
          { id: 'toolu_2', function: { name: 'read', arguments: { path: 'b.ts' } } },
        ],
      },
      { role: 'tool', content: 'contents of a', tool_call_id: 'toolu_1' },
      { role: 'tool', content: 'contents of b', tool_call_id: 'toolu_2' },
    ]
    await provider.chatWithTools('claude-haiku-4-5-20251001', messages, [tool('read')])
    const body = bodies[0]

    // Wire shape stays the B7 shape: user, assistant(2x tool_use), user(2x tool_result).
    expect(body.messages).toHaveLength(3)
    const stable = body.messages[1]
    expect(stable.role).toBe('assistant')
    expect(stable.content[stable.content.length - 1].type).toBe('tool_use')
    expect(stable.content[stable.content.length - 1].cache_control).toEqual(EPHEMERAL)
    // The just-arrived tool results are the volatile tail, so no marker.
    for (const block of body.messages[2].content) {
      expect(block.cache_control).toBeUndefined()
    }
    expect(markerPaths(body)).toHaveLength(3)
  })
})

describe('A8 no beta header', () => {
  it('keeps anthropic-version 2023-06-01 and sends no anthropic-beta opt-in', async () => {
    const { headers } = captureJson()
    const provider = new AnthropicProvider(makeConfig())

    await provider.chatWithTools('claude-haiku-4-5-20251001', conversation(1), [tool('read')])

    // Prompt caching is GA on this API version. An unknown beta value would
    // only add a failure surface on the proxies people front this with.
    expect(headers[0]['anthropic-version']).toBe('2023-06-01')
    expect(headers[0]['anthropic-beta']).toBeUndefined()
  })
})
