import { expect, type Page } from '@playwright/test'

/**
 * Open a fresh conversation and wait for the composer to actually exist.
 *
 * Right after onboarding (or an appMode flip) the model list populates
 * asynchronously, and Sidebar.handleNewChat treats a click without an
 * active model as "nothing to chat with": local mode routes to the Models
 * page (the mylogz guard), cloud mode ignores the click. A real user just
 * clicks New Chat again once the list is in; this retry mirrors that user
 * instead of racing the fetch. The race never fires on a fast machine but
 * is near-deterministic on the slow Windows PW box, where the first click
 * always loses against the model-list round trip.
 */
export async function openNewChat(page: Page): Promise<void> {
  await expect(async () => {
    // Land back in the chat view first in case an earlier losing click
    // parked us on the Models page.
    const back = page.getByRole('button', { name: /Back to chat/i })
    if (await back.isVisible().catch(() => false)) await back.click()
    await page.getByRole('button', { name: /New Chat/i }).click()
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}
