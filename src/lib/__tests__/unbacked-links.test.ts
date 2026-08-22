/**
 * Z36 finding 3 (W3 run 2026-08-16): with one real tool success in the
 * history the model fabricated the next ones, confident links no tool ever
 * returned, and the G14 guards could not see it because the MODEL was the
 * author, not the app. These tests lock the deterministic detector (a URL
 * absent from everything the model was shown cannot come from a tool), the
 * one-steer-then-flag contract in useAgentChat, and the labelled notice in
 * the bubble. The negative controls pin the under-flagging bias: anything
 * the model was actually shown is never called invented.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  extractUrls,
  normalizeUrl,
  findUnbackedLinks,
  unbackedLinksSteer,
  unbackedLinksNotice,
} from '../unbacked-links'

describe('extractUrls', () => {
  it('finds bare and markdown-wrapped http(s) URLs', () => {
    const text =
      'See https://example.com/a and [docs](https://docs.example.org/guide) plus http://plain.io.'
    expect(extractUrls(text)).toEqual([
      'https://example.com/a',
      'https://docs.example.org/guide',
      'http://plain.io',
    ])
  })

  it('trims trailing sentence punctuation but keeps the path', () => {
    expect(extractUrls('Read https://a.io/x/y?z=1, then stop.')).toEqual(['https://a.io/x/y?z=1'])
  })

  it('returns nothing for prose without URLs (negative control)', () => {
    expect(extractUrls('no links here, just example.com mentioned barely')).toEqual([])
    expect(extractUrls('')).toEqual([])
  })
})

describe('normalizeUrl', () => {
  it('drops protocol, www, fragment, one trailing slash, and lowercases', () => {
    expect(normalizeUrl('HTTPS://WWW.Example.COM/Path/')).toBe('example.com/path')
    expect(normalizeUrl('http://example.com/page#section')).toBe('example.com/page')
  })

  it('keeps the query string, a different query is a different resource', () => {
    expect(normalizeUrl('https://a.io/s?q=1')).toBe('a.io/s?q=1')
  })
})

describe('findUnbackedLinks', () => {
  const toolResult = 'Search results:\n1. https://real-source.com/article (fetched)\nsome text'

  it('flags a link that appears nowhere in the shown corpus', () => {
    const answer = 'According to https://invented-news.com/story this is true.'
    expect(findUnbackedLinks(answer, toolResult)).toEqual(['https://invented-news.com/story'])
  })

  it('NEGATIVE CONTROL: a link the tool really returned is never flagged', () => {
    const answer = 'Source: https://real-source.com/article'
    expect(findUnbackedLinks(answer, toolResult)).toEqual([])
  })

  it('NEGATIVE CONTROL: protocol, www, case and trailing-slash variants still count as backed', () => {
    const answer = 'Source: http://WWW.Real-Source.com/Article/'
    expect(findUnbackedLinks(answer, toolResult.toLowerCase())).toEqual([])
  })

  it('NEGATIVE CONTROL: a bare-domain mention in the corpus backs the https link in the answer', () => {
    const answer = 'Docs: https://example.com/docs/setup'
    const corpus = 'the readme says to open example.com/docs/setup in a browser'
    expect(findUnbackedLinks(answer, corpus)).toEqual([])
  })

  it('deduplicates by normalized form and keeps the model spelling', () => {
    const answer = 'See https://Fake.io/x and https://fake.io/x/ twice.'
    expect(findUnbackedLinks(answer, 'nothing')).toEqual(['https://Fake.io/x'])
  })

  it('an answer without URLs never flags, whatever the corpus (negative control)', () => {
    expect(findUnbackedLinks('all prose, no links', '')).toEqual([])
  })

  it('mixed answer: only the invented link is flagged, the backed one passes', () => {
    const answer = 'Real: https://real-source.com/article, fake: https://made-up.net/page'
    expect(findUnbackedLinks(answer, toolResult)).toEqual(['https://made-up.net/page'])
  })
})

describe('unbackedLinksSteer', () => {
  it('names every invented link and both honest ways out', () => {
    const steer = unbackedLinksSteer(['https://a.io/1', 'https://b.io/2'])
    expect(steer).toContain('https://a.io/1')
    expect(steer).toContain('https://b.io/2')
    expect(steer).toContain('call a tool')
    expect(steer).toContain('rewrite your final answer')
  })

  it('singular wording for one link', () => {
    expect(unbackedLinksSteer(['https://a.io/1'])).toContain('a link that no tool returned')
  })
})

describe('unbackedLinksNotice', () => {
  it('null when there is nothing to flag, so the bubble renders nothing (negative control)', () => {
    expect(unbackedLinksNotice(undefined)).toBeNull()
    expect(unbackedLinksNotice([])).toBeNull()
  })

  it('one link: singular sentence naming it without protocol', () => {
    expect(unbackedLinksNotice(['https://fake.io/x'])).toBe(
      'This link came from the model, not from any tool result: fake.io/x'
    )
  })

  it('many links: counts them, shows three, sums the rest', () => {
    const notice = unbackedLinksNotice([
      'https://a.io/1',
      'https://b.io/2',
      'https://c.io/3',
      'https://d.io/4',
      'https://e.io/5',
    ])
    expect(notice).toContain('5 links came from the model')
    expect(notice).toContain('a.io/1, b.io/2, c.io/3')
    expect(notice).toContain('and 2 more')
    expect(notice).not.toContain('d.io/4')
  })
})

describe('wiring (source guards)', () => {
  const agentSrc = readFileSync(join(__dirname, '../../hooks/useAgentChat.ts'), 'utf8')
  const bubbleSrc = readFileSync(join(__dirname, '../../components/chat/MessageBubble.tsx'), 'utf8')
  const storeSrc = readFileSync(join(__dirname, '../../stores/chatStore.ts'), 'utf8')

  it('the agent loop runs the detector on the final turn and steers with it', () => {
    expect(agentSrc).toContain('findUnbackedLinks(turnContent, shownToModel)')
    expect(agentSrc).toContain('unbackedLinksSteer(invented)')
  })

  it('the notice runs on every final turn; the persona run proved a prose-only model never arms a success gate', () => {
    // Z36 counter-check 2026-08-22: Hermes-3-3B wrote its tool calls as
    // prose, no call ever ran, and invented links stood unmarked behind the
    // old `anyToolSucceeded &&` gate. The label must not depend on a success.
    expect(agentSrc).toContain('anyToolSucceeded = true')
    expect(agentSrc).not.toContain('if (anyToolSucceeded && turnContent.trim())')
    expect(agentSrc).toContain('if (turnContent.trim())')
  })

  it('only the corrective steer stays gated on a real success, fires once, then the message is flagged', () => {
    expect(agentSrc).toContain('if (anyToolSucceeded && !linksSteered)')
    expect(agentSrc).toContain('linksSteered = true')
    expect(agentSrc).toContain('updateMessageUnbackedLinks(convId!, assistantMessage.id, invented)')
  })

  it('the store persists the flag and the bubble renders the labelled notice', () => {
    expect(storeSrc).toContain('updateMessageUnbackedLinks: (conversationId, messageId, unbackedLinks) =>')
    expect(bubbleSrc).toContain('unbackedLinksNotice(message.unbackedLinks)')
  })
})
