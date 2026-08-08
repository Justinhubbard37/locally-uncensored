/**
 * One run, one anchor (G14-6, David 2026-08-07): "anstatt wir diese drei
 * langweiligen Punkte haben … möchte ich Working mit derselben Animation, die
 * wir in unseren Toolcalls haben, außerdem daneben die Zeit … die soll immer
 * der Anker sein für alles, ganz unten, bis der Agent fertig ist. Dann kannst
 * Du die drei Doppelpunkte wegnehmen, überall in Chat, Agent, Code, überall."
 *
 * Run: npx vitest run src/lib/__tests__/working-anchor.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { formatElapsed } from '../format-elapsed'

const here = dirname(fileURLToPath(import.meta.url))
const p = (rel: string) => resolve(here, rel)
const read = (rel: string) => readFileSync(p(rel), 'utf8')

describe('the clock next to the word', () => {
  it('formats like the run header, minutes only when there are minutes', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(47)).toBe('47s')
    expect(formatElapsed(65)).toBe('1m 05s')
    expect(formatElapsed(723)).toBe('12m 03s')
  })

  it('never renders a negative clock', () => {
    expect(formatElapsed(-5)).toBe('0s')
  })
})

describe('the dots are gone, everywhere', () => {
  it('TypingIndicator no longer exists', () => {
    expect(existsSync(p('../../components/chat/TypingIndicator.tsx'))).toBe(false)
  })

  it('the floating bottom-right counter no longer exists', () => {
    expect(existsSync(p('../../components/chat/RealtimeCounter.tsx'))).toBe(false)
  })

  it('no chat surface imports either of them', () => {
    for (const f of ['MessageList', 'CodexView', 'ChatView']) {
      const src = read(`../../components/chat/${f}.tsx`)
      expect(src, f).not.toContain('TypingIndicator')
      expect(src, f).not.toContain('RealtimeCounter')
    }
  })
})

describe('the anchor is wired on every surface', () => {
  const anchor = read('../../components/chat/WorkingAnchor.tsx')

  it('carries the SAME shimmer class as a live tool name', () => {
    expect(anchor).toContain('lu-tool-shimmer')
    // and that class really is the tool shimmer, not a lookalike
    expect(read('../../index.css')).toContain('.lu-tool-shimmer')
  })

  it('MessageList (Chat + Agent) renders it while the run lives', () => {
    expect(read('../../components/chat/MessageList.tsx')).toContain('<WorkingAnchor')
  })

  it('CodexView (Code) renders it and names an approval wait for what it is', () => {
    const src = read('../../components/chat/CodexView.tsx')
    expect(src).toContain('<WorkingAnchor')
    expect(src).toContain("'Waiting for your approval'")
  })

  it('NEGATIVE CONTROL: the anchor renders nothing once the run is over', () => {
    expect(anchor).toContain('if (!isRunning) return null')
  })
})
