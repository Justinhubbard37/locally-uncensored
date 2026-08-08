// Group chat v1 (Nurse KillJoy): turn order, attribution tagging, and the
// store half. Component wiring is source-guarded (no render harness here).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { isGroupChat, groupSystemPrompt, groupHistory, GROUP_CHAT_MAX } from '../group-chat'
import { useChatStore } from '../../stores/chatStore'
import type { Message } from '../../types/chat'

const msg = (o: Partial<Message>): Message => ({
  id: `m-${Math.random().toString(36).slice(2)}`,
  role: 'user',
  content: 'hello',
  timestamp: Date.now(),
  ...o,
})

describe('isGroupChat', () => {
  it('needs at least two models', () => {
    expect(isGroupChat(undefined)).toBe(false)
    expect(isGroupChat([])).toBe(false)
    expect(isGroupChat(['a'])).toBe(false)
    expect(isGroupChat(['a', 'b'])).toBe(true)
    expect(isGroupChat(['a', 'b', 'c', 'd'])).toBe(true)
  })
})

describe('groupSystemPrompt', () => {
  it('names the speaker and the other participants, not the speaker twice', () => {
    const p = groupSystemPrompt('qwen', ['qwen', 'gemma', 'llama'], '')
    expect(p).toContain('You are "qwen"')
    expect(p).toContain('"gemma"')
    expect(p).toContain('"llama"')
    expect(p.indexOf('"qwen"')).toBe(p.lastIndexOf('"qwen"'))
  })

  it('keeps the persona prompt in front when the chat has one', () => {
    const p = groupSystemPrompt('qwen', ['qwen', 'gemma'], 'You are a pirate.')
    expect(p.startsWith('You are a pirate.')).toBe(true)
    expect(p).toContain('You are "qwen"')
  })
})

describe('groupHistory', () => {
  const history: Message[] = [
    msg({ role: 'user', content: 'what is love' }),
    msg({ role: 'assistant', content: 'baby dont hurt me', modelId: 'gemma' }),
    msg({ role: 'assistant', content: 'no more', modelId: 'qwen' }),
    msg({ role: 'assistant', content: '' }),
  ]

  it('tags the OTHER models and leaves own turns clean', () => {
    const forQwen = groupHistory(history, 'qwen')
    expect(forQwen[1].content).toBe('[gemma] baby dont hurt me')
    expect(forQwen[2].content).toBe('no more')
  })

  it('leaves user lines untouched and drops empty placeholders', () => {
    const forQwen = groupHistory(history, 'qwen')
    expect(forQwen[0]).toMatchObject({ role: 'user', content: 'what is love' })
    expect(forQwen).toHaveLength(3)
  })

  it('carries image attachments through', () => {
    const withImg = [msg({ role: 'user', content: 'look', images: [{ name: 'x.png', data: 'AAA', mimeType: 'image/png' }] })]
    const out = groupHistory(withImg, 'qwen')
    expect(out[0].images).toEqual([{ data: 'AAA', mimeType: 'image/png' }])
  })
})

describe('chatStore.setGroupModels', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: [], activeConversationId: null })
  })

  it('stores the line-up on the conversation and caps it at four', () => {
    const id = useChatStore.getState().createConversation('gemma4:12b', '', 'lu')
    useChatStore.getState().setGroupModels(id, ['a', 'b', 'c', 'd', 'e'])
    const conv = useChatStore.getState().conversations[0]
    expect(conv.groupModels).toEqual(['a', 'b', 'c', 'd'])
    expect(conv.groupModels!.length).toBe(GROUP_CHAT_MAX)
  })

  it('clearing turns the chat back into a single-model chat', () => {
    const id = useChatStore.getState().createConversation('gemma4:12b', '', 'lu')
    useChatStore.getState().setGroupModels(id, ['a', 'b'])
    useChatStore.getState().setGroupModels(id, [])
    expect(isGroupChat(useChatStore.getState().conversations[0].groupModels)).toBe(false)
  })
})

describe('wiring (source guards)', () => {
  const useChatSrc = readFileSync(join(__dirname, '../../hooks/useChat.ts'), 'utf8')
  const bubbleSrc = readFileSync(join(__dirname, '../../components/chat/MessageBubble.tsx'), 'utf8')
  const pluginsSrc = readFileSync(join(__dirname, '../../components/chat/PluginsDropdown.tsx'), 'utf8')

  it('the group branch runs BEFORE the chat-tools router', () => {
    const branch = useChatSrc.indexOf('isGroupChat(groupConv.groupModels)')
    const router = useChatSrc.indexOf('resolveChatToolRoute(')
    expect(branch).toBeGreaterThan(-1)
    expect(router).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(router)
  })

  it('every group turn is labeled and one abort spans the whole round', () => {
    expect(useChatSrc).toContain('modelId: model')
    expect(useChatSrc).toContain('await runGroupTurn(convId, model, models, abort)')
    expect(useChatSrc).toContain('if (abort.signal.aborted) break')
  })

  it('the bubble names the speaker only when a turn carries a model', () => {
    expect(bubbleSrc).toContain('{!isUser && message.modelId && (')
  })

  it('the dropdown writes the line-up onto the active conversation', () => {
    expect(pluginsSrc).toContain('setGroupModels(')
    expect(pluginsSrc).toContain('GROUP_CHAT_MAX')
  })
})
