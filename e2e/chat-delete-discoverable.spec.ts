import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { openNewChat } from './support/ui'

/**
 * Deleting a chat has to be findable (sweenscapehub, Discord 2026-07-30):
 * "I have searched the whole app and right clicked the chats, checked github
 * readme faq — there doesn't seem to be a intuitive way to delete a chat".
 *
 * The button existed the whole time, at 10 px, unlabelled, and only while the
 * pointer sat on the row. Right-click, the gesture they tried first, did
 * nothing. So this spec pins the two ways out: the context menu, and hover
 * buttons that carry a name a human and a screen reader can both read.
 *
 * Run: npx playwright test e2e/chat-delete-discoverable.spec.ts
 */

/** Conversation rows in the sidebar, counted by their delete affordance. */
const rowCount = async (page: Page) => await page.getByRole('button', { name: 'Delete chat' }).count()

async function bootWithTwoChats(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await page.goto('/')
  await page.getByRole('button', { name: /Get Started/i }).click()
  await page.getByRole('button', { name: /Continue/i }).click()
  await page.getByRole('button', { name: /Skip for now/i }).click()
  await expect(page.getByRole('heading', { name: /Pick a starter model/i })).toBeVisible()
  await page.getByRole('button', { name: /Qwen 2\.5 0\.5B/i }).click()
  await page.getByRole('button', { name: /Install \d+ model/i }).click()
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /Skip for now/i }).click()
  await page.getByRole('button', { name: /Get Started/i }).click()

  // Two conversations so a delete shows up as a count change. The first one
  // carries a real exchange, the second is the empty chat you get from the
  // button — both are rows in the sidebar.
  await openNewChat(page)
  await page.locator('textarea').first().fill('first chat')
  await page.locator('textarea').first().press('Enter')
  await expect(page.getByText(DEFAULT_ASSISTANT_REPLY).first()).toBeVisible({ timeout: 30_000 })
  await openNewChat(page)
  await expect.poll(async () => await rowCount(page)).toBe(2)
}

test('right-clicking a chat offers rename and delete, and delete removes it', async ({ page }) => {
  await bootWithTwoChats(page)
  const before = await rowCount(page)
  expect(before).toBeGreaterThanOrEqual(2)

  await page.getByRole('button', { name: 'Delete chat' }).first().hover()
  await page.mouse.down({ button: 'right' })
  await page.mouse.up({ button: 'right' })

  const menu = page.getByRole('menu', { name: /Chat actions/i })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Rename/i })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Delete chat/i })).toBeVisible()

  await menu.getByRole('menuitem', { name: /Delete chat/i }).click()
  await expect(menu).toHaveCount(0)
  await expect.poll(async () => await rowCount(page)).toBe(before - 1)
})

test('escape closes the menu without deleting anything', async ({ page }) => {
  await bootWithTwoChats(page)
  const before = await rowCount(page)

  await page.getByRole('button', { name: 'Delete chat' }).first().hover()
  await page.mouse.down({ button: 'right' })
  await page.mouse.up({ button: 'right' })
  await expect(page.getByRole('menu', { name: /Chat actions/i })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: /Chat actions/i })).toHaveCount(0)
  expect(await rowCount(page)).toBe(before)
})

test('the row buttons carry names, so they are findable without guessing', async ({ page }) => {
  await bootWithTwoChats(page)
  // Named for a screen reader and tooltipped for everyone else — the 10 px
  // unlabelled icon is what sent sweenscapehub to Discord.
  await expect(page.getByRole('button', { name: 'Delete chat' }).first()).toHaveAttribute('title', 'Delete chat')
  await expect(page.getByRole('button', { name: 'Rename chat' }).first()).toHaveAttribute('title', 'Rename chat')
})
