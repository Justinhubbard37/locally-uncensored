/**
 * G33 (David 2026-08-07): "wenn ein Text abgeschickt wird, soll der Chat nach
 * ganz unten springen, wo Working dann zu sehen ist; momentan springt er
 * runter, aber nie ganz."
 *
 * The old pin fired only when the trigger STRING changed. Two kinds of height
 * appear below the fold without it: the Working anchor mounts on a prop flip,
 * and a reasoning model streams into a thinking block while the message
 * content stays empty. The view then parks one anchor-height short of the
 * bottom for the entire thinking phase, which is exactly the report.
 *
 * Run: npx vitest run src/components/chat/__tests__/scroll-pins-bottom.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')
const hook = read('../../../hooks/useAutoScroll.ts')
const messageList = read('../MessageList.tsx')

describe('the list follows every growth, not just anticipated triggers', () => {
  it('a ResizeObserver on the content wrapper re-pins on growth', () => {
    expect(hook).toContain('new ResizeObserver(')
    expect(hook).toContain('ro.observe(content)')
  })

  it('MessageList wraps ALL content, anchor included, in that wrapper', () => {
    // The anchor must sit INSIDE the observed wrapper or its mount is
    // invisible to the observer and the original bug returns.
    const wrapperOpen = messageList.indexOf('ref={contentRef}')
    const anchor = messageList.indexOf('<WorkingAnchor')
    expect(wrapperOpen).toBeGreaterThan(-1)
    expect(anchor).toBeGreaterThan(wrapperOpen)
  })

  it('sending re-engages following and jumps fully down', () => {
    // The resumeKey is the last USER message id: a send is an explicit
    // "take me to the newest", whatever the scroll position was.
    expect(messageList).toContain('lastUserMessage?.id')
    expect(hook).toContain('shouldScroll.current = true')
  })

  // ── Negative controls ────────────────────────────────────────────────────

  it('reading history during a run stays possible', () => {
    // The observer pin is gated on the follow flag, and the scroll listener
    // that clears the flag is still wired. Without both, the observer would
    // yank the user back down on every streamed token.
    expect(hook).toMatch(/if \(shouldScroll\.current && el\) el\.scrollTop = el\.scrollHeight/)
    expect(hook).toContain("el.addEventListener('scroll', handleScroll)")
  })

  it('an assistant answer does NOT re-engage following', () => {
    // Only the user message id feeds resumeKey. If the whole message list or
    // the assistant id fed it, streaming would fight the user's scrollback.
    expect(messageList).not.toContain('resumeKey={lastMessage')
    expect(messageList).toContain("messages.filter((m) => m.role === 'user')")
  })

  it('the plain streaming trigger still exists alongside the observer', () => {
    // Environments without ResizeObserver (jsdom in tests) keep the old
    // dependency-driven pin as the fallback path.
    expect(hook).toContain("typeof ResizeObserver === 'undefined'")
    expect(hook).toMatch(/\}, \[dependency\]\)/)
  })

  // G8-3 (#28): "sobald er fertig gedacht hat, hakt das ab und zoomt irgendwo
  // ganz anders hin." The Code tab's hand-rolled pin only fired on
  // [messages, events]; the height swap when a thinking round ends fell
  // between triggers. It now shares this hook, so the observer re-pins on
  // every height change, the collapse included.
  it('the Code tab shares the hook instead of its own partial pin', () => {
    const codex = read('../CodexView.tsx')
    expect(codex).toContain('useAutoScroll(')
    expect(codex).not.toContain('shouldAutoScroll')
  })

  it('Codex wraps the whole list, anchor included, in the observed wrapper', () => {
    const codex = read('../CodexView.tsx')
    const wrapperOpen = codex.indexOf('ref={contentRef}')
    const anchor = codex.indexOf('<WorkingAnchor')
    expect(wrapperOpen).toBeGreaterThan(-1)
    expect(anchor).toBeGreaterThan(wrapperOpen)
  })

  it('Codex re-engages following on the user instruction, not the answer', () => {
    const codex = read('../CodexView.tsx')
    expect(codex).toContain('lastUserMessage?.id')
    expect(codex).toContain("messages.filter((m) => m.role === 'user')")
  })
})
