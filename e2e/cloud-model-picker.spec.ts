import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * The model picker after the unrestricted models learned to call tools
 * (2026-07-29).
 *
 * Everything that decides this lives on the server: LU Cloud returns
 * supports_tools per model, and the app reads it. So the catalogue here is not
 * a fixture, it is fetched LIVE from lu-labs.ai at run time and replayed into
 * the app, which makes this the shipped desktop UI rendering the real
 * production answer.
 *
 *   LU_E2E_TEST_USER_EMAIL=... LU_E2E_TEST_USER_PASSWORD=... npx playwright test e2e/cloud-model-picker.spec.ts
 *
 * Without those the spec skips, like the other live-backed ones.
 */

const email = process.env.LU_E2E_TEST_USER_EMAIL
const password = process.env.LU_E2E_TEST_USER_PASSWORD
const SUPABASE_URL = process.env.LU_E2E_SUPABASE_URL
const SUPABASE_ANON = process.env.LU_E2E_SUPABASE_ANON_KEY
const APP = process.env.LU_E2E_APP_URL ?? 'https://lu-labs.ai'
const enabled = Boolean(email && password && SUPABASE_URL && SUPABASE_ANON)

/** The models DeepInfra refuses a native `tools` payload for. */
const UNRESTRICTED = [
  'Sao10K/L3-8B-Lunaris-v1-Turbo',
  'Gryphe/MythoMax-L2-13b',
  'NousResearch/Hermes-3-Llama-3.1-70B',
  'NousResearch/Hermes-3-Llama-3.1-405B',
  'Sao10K/L3.1-70B-Euryale-v2.2',
  'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
]

let liveCatalogue: { object: string; tier: string; data: Array<Record<string, unknown>> }

test.beforeAll(async () => {
  test.skip(!enabled, 'set LU_E2E_TEST_USER_EMAIL/PASSWORD + LU_E2E_SUPABASE_URL/ANON_KEY to enable')
  const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const token = ((await auth.json()) as { access_token?: string }).access_token
  expect(token, 'live sign-in for the catalogue fetch').toBeTruthy()
  const res = await fetch(`${APP}/api/inference/v1/models`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status, 'live catalogue fetch').toBe(200)
  liveCatalogue = (await res.json()) as typeof liveCatalogue
})

async function bootIntoCloud(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  // Registered after routeCloud, so this handler wins: the app sees exactly
  // what production served a moment ago.
  await page.route('**/api/inference/v1/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(liveCatalogue),
    }),
  )
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
}

/** The composer, and with it the picker, only exists inside a conversation. */
async function openPicker(page: Page) {
  await page.getByRole('button', { name: /New Chat/i }).first().click()
  const trigger = page.getByRole('button', { name: /Select chat model/i })
  await expect(trigger).toBeVisible({ timeout: 20_000 })
  await trigger.click()
}

test('production says every catalogue model can call tools', () => {
  test.skip(!enabled, 'live catalogue not fetched')
  const flags = new Map(liveCatalogue.data.map((m) => [m.id as string, m.supports_tools]))
  for (const id of UNRESTRICTED) {
    expect(flags.get(id), `${id} in the live catalogue`).toBe(true)
  }
  expect([...flags.values()].every((v) => v === true)).toBe(true)
})

test('the chat picker marks the unrestricted models as tool capable', async ({ page }) => {
  test.skip(!enabled, 'needs the live catalogue')
  await bootIntoCloud(page)
  await openPicker(page)

  // One row per unrestricted model, each carrying the wrench the app uses for
  // "this one runs Agent and Code", not the ban marker.
  for (const id of UNRESTRICTED) {
    const label = (liveCatalogue.data.find((m) => m.id === id)?.name as string) ?? id
    const row = page.getByRole('button', { name: label, exact: false }).filter({ hasText: label })
    await row.first().scrollIntoViewIfNeeded()
    await expect(row.first(), `${label} is offered`).toBeVisible({ timeout: 15_000 })
    await expect(
      row.first().locator('[title*="Supports tool calling"]'),
      `${label} is marked tool capable`,
    ).toHaveCount(1)
  }
  expect(await page.locator('[title*="does not support tool calling"]').count()).toBe(0)

  // Set LU_E2E_SHOT to keep the open picker as an image, for showing someone
  // the row rather than describing it.
  if (process.env.LU_E2E_SHOT) await page.screenshot({ path: process.env.LU_E2E_SHOT })
})

test('the code surface offers them too, where they used to be hidden', async ({ page }) => {
  test.skip(!enabled, 'needs the live catalogue')
  await bootIntoCloud(page)
  await page.getByRole('button', { name: /^Code$/ }).first().click()
  await openPicker(page)
  // Code filters out anything that cannot call tools. Nothing is filtered now.
  await expect(page.getByText(/hidden|cannot call tools/i)).toHaveCount(0)
  const label =
    (liveCatalogue.data.find((m) => m.id === 'Sao10K/L3.1-70B-Euryale-v2.2')?.name as string) ??
    'Euryale'
  await expect(page.locator('div', { hasText: label }).last()).toBeVisible({ timeout: 15_000 })
})
