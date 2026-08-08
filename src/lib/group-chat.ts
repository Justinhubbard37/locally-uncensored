// Group chat v1 (Nurse KillJoy, Discord 2026-08-07): two to four models
// answer in turn inside ONE conversation, SillyTavern-style turn order.
// Plain conversation only by design: the agent path and the chat-tools
// router stay out, a group round is talk, never a tool run.
//
// Attribution is the whole trick. Every model receives the shared history
// with the OTHER models' lines tagged "[model-name] ..." and its own lines
// untagged, so each participant can tell who said what without any provider
// support for multi-speaker roles.
import type { Message } from '../types/chat'

export const GROUP_CHAT_MIN = 2
export const GROUP_CHAT_MAX = 4

/** True when this conversation runs as a group. */
export function isGroupChat(groupModels: string[] | undefined): groupModels is string[] {
  return Array.isArray(groupModels) && groupModels.length >= GROUP_CHAT_MIN
}

export function groupSystemPrompt(model: string, allModels: string[], personaPrompt: string): string {
  const others = allModels.filter((m) => m !== model).map((m) => `"${m}"`).join(', ')
  const line =
    `You are "${model}", one of several AI models answering in the same group conversation with ${others}. ` +
    `Earlier assistant messages starting with a [model-name] tag were written by the other models; untagged assistant messages are your own. ` +
    `Answer as yourself in your own voice, add something new, and do not repeat what another model already said.`
  return personaPrompt ? `${personaPrompt}\n\n${line}` : line
}

export interface GroupWireMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  images?: { data: string; mimeType: string }[]
}

/** The shared history as one model sees it: other speakers tagged, own turns
 *  clean, empty placeholders dropped. */
export function groupHistory(messages: Message[], model: string): GroupWireMessage[] {
  return messages
    .filter((m) => m.content.trim() !== '')
    .map((m) => ({
      role: m.role as GroupWireMessage['role'],
      content:
        m.role === 'assistant' && m.modelId && m.modelId !== model
          ? `[${m.modelId}] ${m.content}`
          : m.content,
      ...(m.images?.length ? { images: m.images.map((i) => ({ data: i.data, mimeType: i.mimeType })) } : {}),
    }))
}
