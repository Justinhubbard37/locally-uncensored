/**
 * G31 (R01c, Mac, 2026-08-07): an agent run sat waiting SEVEN MINUTES on an
 * approval. The Approve/Reject buttons were rendered the whole time, on the
 * tool block, far below the fold, and the list never scrolled to them. All the
 * user saw was a clock icon and a composer offering an empty message box.
 *
 * A waiting approval has no timeout, on purpose: awaitApproval sits OUTSIDE
 * raceWithToolTimeout, because a human may legitimately take a while. That
 * makes being seen the only thing that ever ends the wait, which is why these
 * are guards and not preferences.
 *
 * Run: npx vitest run src/components/chat/__tests__/approval-stays-visible.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')
const chatInput = read('../ChatInput.tsx')
const approvalDialog = read('../ApprovalDialog.tsx')
const messageList = read('../MessageList.tsx')
const chatView = read('../ChatView.tsx')
const codexView = read('../CodexView.tsx')

describe('a pending approval is always reachable', () => {
  it('the composer renders the strip, so the decision cannot scroll away', () => {
    // The component existed and was imported by nobody: defined, styled,
    // documented as "rendered directly above the ChatInput", and dead. That is
    // exactly how this bug survived.
    expect(chatInput).toContain("import { ApprovalDialog } from './ApprovalDialog'")
    expect(chatInput).toMatch(/pendingApproval && onApprove && onReject && \(/)
    expect(chatInput).toContain('<ApprovalDialog toolCall={pendingApproval}')
  })

  it('the strip is wired to the same callbacks the chat passes down', () => {
    expect(chatInput).toContain('onApprove={onApprove}')
    expect(chatInput).toContain('onReject={onReject}')
    expect(chatView).toContain('pendingApproval={pendingApproval}')
    expect(chatView).toContain('onApprove={approveToolCall}')
    expect(chatView).toContain('onReject={rejectToolCall}')
  })

  it('a new approval pulls the list down with it', () => {
    // The call shape changed with G33 (resumeKey + content wrapper); the
    // approval id staying in the trigger string is what this guard pins.
    expect(messageList).toContain('`${lastMessage?.content ?? \'\'}|${pendingApprovalId ?? \'\'}`')
  })

  // ── Negative controls ────────────────────────────────────────────────────

  it('EXACTLY ONE keyboard layer answers an approval', () => {
    // Both listeners firing on one Enter would pop TWO entries off the queue:
    // the tool the user saw, plus the next one, approved without ever being
    // shown. ChatView keeps the layer because it works off screen too.
    expect(approvalDialog).not.toContain('addEventListener')
    expect(chatView).toContain("window.addEventListener('keydown', handler)")
  })

  it('the strip does not steal focus from the message box', () => {
    // autoFocus on Approve made sense while this was a modal. In the composer
    // it would yank the caret out of a half-typed message, and it would put
    // Enter on a focused button while ChatView's handler is also listening.
    expect(approvalDialog).not.toContain('autoFocus')
  })

  it('the list still scrolls on plain streaming content', () => {
    // The trigger must keep the content in it, or an ordinary chat answer
    // stops following the stream.
    expect(messageList).toContain('lastMessage?.content')
  })

  it('the Code tab is untouched: it has its own staging queue', () => {
    expect(codexView).not.toContain('pendingApproval=')
  })
})
