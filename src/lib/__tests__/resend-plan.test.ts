/**
 * planResend — the surgery behind the Regenerate and Edit buttons.
 *
 * Measured against the version before this round, which passed the ASSISTANT
 * message to deleteMessagesAfter and then re-sent the question: the store kept
 * the original user message, sendMessage appended a second one, and the thread
 * grew a duplicate question per click. Images never made the trip at all.
 */
import { describe, it, expect } from 'vitest'
import { planResend } from '../resend-plan'
import { useChatStore } from '../../stores/chatStore'

const img = [{ data: 'AAAA', mimeType: 'image/png', name: 'shot.png' }]

const plain = [
  { id: 'u1', role: 'user' as const, content: 'first' },
  { id: 'a1', role: 'assistant' as const, content: 'answer one' },
  { id: 'u2', role: 'user' as const, content: 'second' },
  { id: 'a2', role: 'assistant' as const, content: 'answer two' },
]

describe('regenerate deletes the question too, so it is not asked twice', () => {
  it('anchors on the user message, not on the answer', () => {
    // The old code deleted from 'a2', which left 'u2' behind for sendMessage to
    // duplicate. Deleting from 'u2' is what makes the resend replace the turn.
    expect(planResend(plain, 'a2')).toEqual({ deleteFromId: 'u2', content: 'second' })
  })

  it('regenerating an earlier answer drops everything after that question', () => {
    expect(planResend(plain, 'a1')).toEqual({ deleteFromId: 'u1', content: 'first' })
  })

  it('carries the attachments of the question back into the resend', () => {
    const withImage = [
      { id: 'u1', role: 'user' as const, content: 'what is this?', images: img },
      { id: 'a1', role: 'assistant' as const, content: 'a cat' },
    ]
    // Without this the vision model was re-asked "what is this?" with no image
    // and answered about nothing.
    expect(planResend(withImage, 'a1')).toEqual({
      deleteFromId: 'u1',
      content: 'what is this?',
      images: img,
    })
  })

  it('walks back past the tool results of an agent turn', () => {
    // In agent mode the message before the answer is a tool result, so the old
    // `messages[idx - 1].role !== 'user'` check returned early and the
    // Regenerate button did nothing.
    const agent = [
      { id: 'u1', role: 'user' as const, content: 'read the file' },
      { id: 'a1', role: 'assistant' as const, content: '' },
      { id: 't1', role: 'tool' as const, content: '{"ok":true}' },
      { id: 'a2', role: 'assistant' as const, content: 'it says hello' },
    ]
    expect(planResend(agent, 'a2')?.deleteFromId).toBe('u1')
  })
})

describe('a slash command goes back in as the command, not as its expansion', () => {
  it('resends the "/review" the user typed', () => {
    const slash = [
      { id: 'u1', role: 'user' as const, content: 'Review the changes …long expansion…', displayContent: '/review' },
      { id: 'a1', role: 'assistant' as const, content: 'looks fine' },
    ]
    // sendMessage expands it again; passing the expansion instead would strip
    // the read-only tool gating the command carries.
    expect(planResend(slash, 'a1')?.content).toBe('/review')
  })

  it('ignores a displayContent that is a label rather than input', () => {
    // The /loop driver writes "pass 3 of 5" over the instruction it ran.
    const loop = [
      { id: 'u1', role: 'user' as const, content: 'recheck the build', displayContent: 'pass 3 of 5' },
      { id: 'a1', role: 'assistant' as const, content: 'still green' },
    ]
    expect(planResend(loop, 'a1')?.content).toBe('recheck the build')
  })
})

describe('edit replaces the question in place', () => {
  it('deletes from the edited message and resends the new text', () => {
    expect(planResend(plain, 'u2', 'second, rephrased')).toEqual({
      deleteFromId: 'u2',
      content: 'second, rephrased',
    })
  })

  it('keeps the attachments of the message being edited', () => {
    const withImage = [{ id: 'u1', role: 'user' as const, content: 'what is this?', images: img }]
    expect(planResend(withImage, 'u1', 'describe this')).toEqual({
      deleteFromId: 'u1',
      content: 'describe this',
      images: img,
    })
  })

  it('refuses to edit anything that is not a question', () => {
    expect(planResend(plain, 'a2', 'nope')).toBeNull()
  })
})

describe('against the real store, the thread does not grow a copy per click', () => {
  // What useChat does with the plan: drop from the anchor, then let sendMessage
  // add the question back. The old path passed the ASSISTANT id here.
  function clickRegenerate(convId: string, assistantId: string, old = false) {
    const store = useChatStore.getState()
    const conv = store.conversations.find((c) => c.id === convId)!
    if (old) {
      const idx = conv.messages.findIndex((m) => m.id === assistantId)
      const userMsg = conv.messages[idx - 1]
      store.deleteMessagesAfter(convId, assistantId)
      store.addMessage(convId, { id: `u-${Date.now()}-${Math.random()}`, role: 'user', content: userMsg.content, timestamp: Date.now() })
    } else {
      const plan = planResend(conv.messages, assistantId)!
      store.deleteMessagesAfter(convId, plan.deleteFromId)
      store.addMessage(convId, { id: `u-${Date.now()}-${Math.random()}`, role: 'user', content: plan.content, timestamp: Date.now() })
    }
    useChatStore.getState().addMessage(convId, { id: `a-${Date.now()}-${Math.random()}`, role: 'assistant', content: 'answer', timestamp: Date.now() })
  }

  function seed() {
    useChatStore.setState({ conversations: [], activeConversationId: null })
    const convId = useChatStore.getState().createConversation('m', '')
    useChatStore.getState().addMessage(convId, { id: 'u1', role: 'user', content: 'why?', timestamp: 1 })
    useChatStore.getState().addMessage(convId, { id: 'a1', role: 'assistant', content: 'because', timestamp: 2 })
    return convId
  }

  it('three regenerates leave one question, not four', () => {
    const convId = seed()
    let lastAssistant = 'a1'
    for (let i = 0; i < 3; i++) {
      clickRegenerate(convId, lastAssistant)
      const msgs = useChatStore.getState().conversations.find((c) => c.id === convId)!.messages
      lastAssistant = msgs[msgs.length - 1].id
    }
    const msgs = useChatStore.getState().conversations.find((c) => c.id === convId)!.messages
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(msgs).toHaveLength(2)
  })

  it('counter-proof: the old surgery grew one copy per click', () => {
    const convId = seed()
    let lastAssistant = 'a1'
    for (let i = 0; i < 3; i++) {
      clickRegenerate(convId, lastAssistant, true)
      const msgs = useChatStore.getState().conversations.find((c) => c.id === convId)!.messages
      lastAssistant = msgs[msgs.length - 1].id
    }
    const msgs = useChatStore.getState().conversations.find((c) => c.id === convId)!.messages
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(4)
  })
})

describe('nothing to resend', () => {
  it('unknown id', () => {
    expect(planResend(plain, 'nope')).toBeNull()
  })

  it('an answer with no question before it', () => {
    expect(planResend([{ id: 'a1', role: 'assistant' as const, content: 'orphan' }], 'a1')).toBeNull()
  })

  it('an empty thread', () => {
    expect(planResend([], 'a1')).toBeNull()
  })
})
