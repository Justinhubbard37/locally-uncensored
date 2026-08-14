/**
 * The one line that says "the file on disk is not the diff you approved" has
 * to reach the user.
 *
 * Review 2026-08-14. applyStagedChange writes that line into the chat log with
 * a comment saying it is there "so the user sees a confirmation in the main
 * pane", and then flagged it `hidden: true`. Both renderers drop hidden
 * messages, and MessageList drops every system role on top of that, so the
 * notice rendered nowhere at all. The Pending row just disappeared, exactly as
 * it does after a clean apply, and with codexAutoApply on the user never even
 * clicked. There is no undo on that write.
 *
 * The other wrong answer would have been to let it render as an assistant
 * bubble: that claims the model said it (the same rule useCodex states where
 * it refuses to author answer text on the model's behalf). So it renders as a
 * plain notice line, and it stays role:'system' so the payload builder keeps
 * dropping it and the model never sees it.
 *
 * Run: npx vitest run src/components/chat/__tests__/staged-apply-notice-reaches-the-user.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')
const codexView = read('../CodexView.tsx')
const stagedApply = read('../../../lib/staged-apply.ts')
const useCodex = read('../../../hooks/useCodex.ts')
const chatTypes = read('../../../types/chat.ts')

describe('the notice is written to be seen', () => {
  it('carries no hidden flag any more', () => {
    // Comments stripped: the doc above the call quotes the old flag on purpose,
    // so the whole file would match while the code is clean.
    const codeOnly = stagedApply
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    expect(codeOnly).not.toMatch(/hidden:\s*true/)
  })

  it('marks a merged apply as something to act on, a clean one as confirmation', () => {
    expect(stagedApply).toContain("notice: merged > 0 ? 'warn' : 'info'")
    expect(stagedApply).toMatch(/not byte for byte the diff you approved/)
  })

  it('the flag exists on the message type, so this is not a stray property', () => {
    expect(chatTypes).toMatch(/notice\?: 'info' \| 'warn'/)
  })
})

describe('the coding view renders it as a notice, not as the model talking', () => {
  it('has a branch for it before the bubble branch', () => {
    const list = codexView.slice(codexView.indexOf('messages.filter(msg => !msg.hidden)'))
    const branch = list.indexOf("msg.role === 'system' && msg.notice")
    const bubble = list.indexOf("msg.role === 'user' ? 'flex-row-reverse' : ''")
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(bubble)
  })

  it('a warn notice looks different from a confirmation', () => {
    const branch = codexView.slice(
      codexView.indexOf("msg.role === 'system' && msg.notice"),
      codexView.indexOf('// Slash commands:'),
    )
    expect(branch).toContain("const warn = msg.notice === 'warn'")
    expect(branch).toContain('AlertTriangle')
    expect(branch).toContain('amber')
    expect(branch).toContain('{msg.content}')
  })
})

describe('and the model still never sees it', () => {
  it('the payload builder drops the system role', () => {
    expect(useCodex).toContain("m.role !== 'system'")
  })
})
