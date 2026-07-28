import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'

/**
 * ENG-5 acceptance — the built-in engine's context window is HONEST end to end:
 *
 *   1. The Context dropdown relaunches the engine with the chosen ctx (the
 *      tuning is injected from settings into swap_bundled_model), and the
 *      TokenCounter denominator follows the engine's reported ctx — not a
 *      hardcoded guess (the pre-2.6.0 counter lied with a fixed 16k).
 *   2. The Settings → AI Backends expert panel (ENG-2) shows the live engine
 *      status incl. its real ctx and "Apply & Restart Engine" relaunches with
 *      the edited tuning.
 *
 * The Tauri mock mirrors ENG-1 Rust semantics: every start/swap derives the
 * engine ctx from the injected tuning and `bundled_engine_status` reports it.
 */

async function completeBuiltinOnboarding(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await page.goto('/')

  await expect(page.getByRole('button', { name: /Get Started/i })).toBeVisible()
  await page.getByRole('button', { name: /Get Started/i }).click()
  await expect(page.getByRole('button', { name: /Continue/i })).toBeVisible()
  await page.getByRole('button', { name: /Continue/i }).click()
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeVisible()
  await page.getByRole('button', { name: /Skip for now/i }).click()
  await expect(page.getByRole('heading', { name: /Pick a starter model/i })).toBeVisible()
  await page.getByRole('button', { name: /Qwen 2\.5 0\.5B/i }).click()
  await page.getByRole('button', { name: /Install \d+ model/i }).click()
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /Skip for now/i }).click()
  await expect(page.getByRole('button', { name: /Get Started/i })).toBeVisible()
  await page.getByRole('button', { name: /Get Started/i }).click()
}

test('context dropdown relaunches the built-in engine and the counter follows', async ({ page }) => {
  await completeBuiltinOnboarding(page)

  // Chat once so the TokenCounter renders (it needs messages).
  await page.getByRole('button', { name: /New Chat/i }).click()
  const composer = page.locator('textarea').first()
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await composer.fill('ping the built-in engine')
  await page.getByRole('button', { name: /Send message/i }).click()
  await expect(page.getByText(/PONG_BUILTIN_OK/)).toBeVisible({ timeout: 20_000 })

  // Default tuning: engine runs with -c 8192 → dropdown trigger "ctx 8K",
  // counter denominator 8.2k. Both read the SAME status.ctx (ENG-3).
  const trigger = page.getByRole('button', { name: /ctx 8K/ })
  await expect(trigger).toBeVisible()
  await expect(page.getByText(/\/8\.2k/)).toBeVisible()

  // Pick 16K → apply() persists tuning.ctx and swaps the running engine.
  // The preset list is capped at the model's TRAINED ceiling (32k from the
  // GGUF header via the listing) — no 64K/128K options for a 32k model.
  await trigger.click()
  await expect(page.getByRole('button', { name: /^32K$/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^64K$/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^128K$/ })).toHaveCount(0)
  await page.getByRole('button', { name: /^16K$/ }).click()

  await expect(page.getByRole('button', { name: /ctx 16K/ })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/\/16\.4k/)).toBeVisible()

  // The relaunch carried the settings-injected tuning, aimed at the loaded GGUF.
  const swap = await page.evaluate(() => {
    const calls = (window as unknown as { __E2E_ENGINE_CALLS__?: { cmd: string; modelPath?: string; tuning?: { ctx?: number } }[] }).__E2E_ENGINE_CALLS__ || []
    return calls.filter((c) => c.cmd === 'swap_bundled_model').pop() ?? null
  })
  expect(swap?.tuning?.ctx).toBe(16384)
  expect(swap?.modelPath).toContain(DEFAULT_MODEL_NAME)
})

test('expert panel shows live engine status and Apply & Restart uses the edited tuning', async ({ page }) => {
  await completeBuiltinOnboarding(page)

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: /AI Backends/i }).click()

  // The expert section only renders while the managed built-in engine
  // occupies the openai slot — which the onboarding just configured. It is
  // a collapsed <Section>; open it first.
  await page.getByRole('button', { name: /Built-in Engine \(expert\)/i }).click()
  await expect(page.getByText(/Expert settings for the built-in engine/i)).toBeVisible()
  await expect(page.getByText(/Engine running/)).toBeVisible()
  await expect(page.getByText(/ctx 8,192/)).toBeVisible()

  // Raise the context, then Apply & Restart → swap with the new tuning and
  // the status line re-reads the engine's real ctx.
  const ctxInput = page.locator('input[placeholder="8192"]')
  await ctxInput.fill('32768')
  await page.getByRole('button', { name: /Apply & Restart Engine/i }).click()
  await expect(page.getByText(/ctx 32,768/)).toBeVisible({ timeout: 10_000 })

  const swap = await page.evaluate(() => {
    const calls = (window as unknown as { __E2E_ENGINE_CALLS__?: { cmd: string; tuning?: { ctx?: number; cacheTypeK?: string } }[] }).__E2E_ENGINE_CALLS__ || []
    return calls.filter((c) => c.cmd === 'swap_bundled_model').pop() ?? null
  })
  expect(swap?.tuning?.ctx).toBe(32768)
  // The full tuning blob rides along (not just ctx) — the whole point of ENG-2.
  expect(swap?.tuning?.cacheTypeK).toBeDefined()
})
