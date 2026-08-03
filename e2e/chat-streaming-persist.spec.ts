import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * Regression cover for the 2.6.3 renderer Out of Memory (Morgan, 2026-08-03).
 *
 * The fix has two halves that only a real browser can check together:
 *   1. chatStore persists through a COALESCING storage, so a streaming answer
 *      costs a handful of IndexedDB writes instead of one per animation frame.
 *      The risk of any write coalescing is losing the tail — so this asserts
 *      the finished answer really is on disk and survives a reload.
 *   2. MessageBubble is memo()d, which only holds up while MessageList hands it
 *      stable handlers. Get that wrong and the streaming bubble freezes
 *      mid-answer — invisible to unit tests, obvious here.
 *
 * The reply arrives in 24 frames so the store is driven the way a real engine
 * drives it, not in one shot.
 */

const REPLY = 'Streaming answer that arrives token by token and must land in full.'
const CHUNKS = 24

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: REPLY,
    modelName: DEFAULT_MODEL_NAME,
    replyChunks: CHUNKS,
    replyChunkDelayMs: 12,
  })
  await seedOnboardingDone(page)
  await page.goto('/')
}

async function send(page: Page, text: string) {
  const composer = page.locator('textarea').first()
  await expect(composer).toBeVisible({ timeout: 20_000 })
  // The composer drops a send issued while the previous turn is still
  // finishing, and the visible reply appears a few frames before the turn
  // actually ends, so settle first.
  await page.waitForTimeout(1500)
  await composer.fill(text)
  await page.getByRole('button', { name: /Send message/i }).click()
}

/** Scoped to the transcript — the sidebar shows the first message as the
 *  conversation title, which would match every bare getByText twice. */
function inChat(page: Page, text: string) {
  return page.getByRole('main').getByText(text)
}

test('a streamed answer renders live, lands in full, and survives a reload', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /New Chat/i }).click()

  await send(page, 'FIRST-TURN-MARKER')
  // The memoised bubble did not freeze: the WHOLE answer arrives, not the
  // first frame of it.
  await expect(inChat(page, REPLY)).toBeVisible({ timeout: 30_000 })
  await expect(inChat(page, 'FIRST-TURN-MARKER')).toBeVisible()

  // A second turn must not disturb the first — the memo keeps earlier bubbles
  // mounted, and they have to keep their content.
  await send(page, 'SECOND-TURN-MARKER')
  // Wait for the SECOND answer, not just the echoed prompt: two bubbles now
  // carry the reply. Reloading before this would test a half-streamed turn.
  await expect(inChat(page, REPLY)).toHaveCount(2, { timeout: 30_000 })
  await expect(inChat(page, 'SECOND-TURN-MARKER')).toBeVisible()
  await expect(inChat(page, 'FIRST-TURN-MARKER')).toBeVisible()

  // The coalescing storage must still have written it. Reload with a cold
  // renderer and read it back out of real IndexedDB.
  await page.reload()

  await expect(inChat(page, 'FIRST-TURN-MARKER')).toBeVisible({ timeout: 30_000 })
  await expect(inChat(page, 'SECOND-TURN-MARKER')).toBeVisible()
  await expect(inChat(page, REPLY).first()).toBeVisible()

  // And assert it at the source, not just on screen: the persisted record
  // carries the COMPLETE answer, not a truncated prefix.
  const persisted = await page.evaluate(async () => {
    const raw: string | null = await new Promise((res) => {
      const req = indexedDB.open('locally-uncensored-store', 1)
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', 'readonly')
        const r = tx.objectStore('kv').get('chat-conversations')
        r.onsuccess = () => res(typeof r.result === 'string' ? r.result : null)
        r.onerror = () => res(null)
      }
      req.onerror = () => res(null)
    })
    if (!raw) return null
    const conv = JSON.parse(raw).state.conversations[0]
    return conv.messages.map((m: { role: string; content: string }) => m.content)
  })

  expect(persisted).not.toBeNull()
  expect(persisted!.some((c: string) => c.includes('FIRST-TURN-MARKER'))).toBe(true)
  expect(persisted!.some((c: string) => c.includes('SECOND-TURN-MARKER'))).toBe(true)
  expect(persisted!.filter((c: string) => c.includes(REPLY)).length).toBe(2)
})
