import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'

/**
 * macOS local Create — the MLX path (MAC-5).
 *
 * The Mac has no ComfyUI: local images and video run through the in-process
 * MLX sidecar (commands/mlx.rs, video.rs). Until this file the whole surface
 * had zero e2e coverage, so the platform split was only ever verified by
 * reading code. Every test here pins the platform explicitly — the app derives
 * it from navigator, so an unpinned spec would silently test whatever laptop
 * ran it.
 *
 * What's covered: which lanes the Mac offers, that image and video actually
 * dispatch to MLX (and never to ComfyUI), that the installer a fresh Mac needs
 * exists and works, and — as the regression guard — that Windows is untouched.
 */

const MAC_OPTS: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'mac',
}

async function bootLocalCreate(page: Page, opts: TauriMockOptions) {
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
}

/** Everything the page recorded through the mocked MLX commands. */
function mlxCalls(page: Page) {
  return page.evaluate(() => (window as unknown as { __E2E_MLX_CALLS__?: unknown[] }).__E2E_MLX_CALLS__ ?? [])
}

test('mac local: MLX lanes run locally, cloud-only lanes stay visible as teasers', async ({ page }) => {
  await bootLocalCreate(page, MAC_OPTS)

  // The two lanes MLX genuinely serves are plain, selectable radios.
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: 'Video', exact: true })).toBeVisible()

  // Everything hosted-only keeps its place in the bar as a locked teaser —
  // David's rule: what can't run locally is still shown, not deleted.
  for (const label of ['Upscale', 'Erase Object', 'Character Studio', 'Talking Character', 'Music', 'Extend Video', 'Motion Control']) {
    await expect(page.getByRole('radio', { name: `${label}, runs on LU Cloud` })).toBeVisible()
  }

  // A locked lane opens the teaser instead of switching the lane.
  await page.getByRole('radio', { name: 'Music, runs on LU Cloud' }).click()
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeChecked()

  // Lanes that need a ComfyUI upload/node have no Mac path at all and are not
  // offered — a visible-but-broken button would be the worse outcome.
  await expect(page.getByRole('radio', { name: /^Remove Background/ })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: /^Edit \/ Image to Image/ })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: /^Animate Image/ })).toHaveCount(0)
})

test('mac local: image generate dispatches to MLX, never to ComfyUI', async ({ page }) => {
  await bootLocalCreate(page, MAC_OPTS)
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })

  const composer = page.locator('textarea').first()
  await composer.fill('a red apple on a wooden table')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect
    .poll(async () => (await mlxCalls(page)).filter((c: any) => c.cmd === 'mlx_generate').length, { timeout: 30_000 })
    .toBeGreaterThan(0)

  const gen = (await mlxCalls(page)).find((c: any) => c.cmd === 'mlx_generate') as any
  expect(gen.prompt).toContain('a red apple')

  // The render came back as a data: PNG and is on screen.
  await expect(page.locator('img[src^="data:image/png"]').first()).toBeVisible({ timeout: 30_000 })

  // The point of the whole platform split: no ComfyUI call was even attempted.
  const comfy = await page.evaluate(
    () => (window as unknown as { __E2E_COMFY_CALLS__?: unknown[] }).__E2E_COMFY_CALLS__ ?? [],
  )
  expect(comfy).toHaveLength(0)
})

test('mac local: video generate dispatches to the MLX video model', async ({ page }) => {
  await bootLocalCreate(page, MAC_OPTS)
  await page.getByRole('radio', { name: 'Video', exact: true }).click()

  const composer = page.locator('textarea').first()
  await composer.fill('slow drifting clouds over a lake')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect
    .poll(async () => (await mlxCalls(page)).filter((c: any) => c.cmd === 'video_generate').length, { timeout: 40_000 })
    .toBeGreaterThan(0)

  const gen = (await mlxCalls(page)).find((c: any) => c.cmd === 'video_generate') as any
  expect(gen.id).toBe('wan21-t2v-1.3b')
  expect(gen.prompt).toContain('drifting clouds')
})

test('fresh mac: the Local Media panel installs the engine and a model', async ({ page }) => {
  // A Mac that has never generated anything: no venv, no models. Before MAC-3
  // this state had no way out — the Rust install commands existed but nothing
  // called them, so local Create just failed.
  await page.addInitScript(tauriMockInit, {
    ...MAC_OPTS,
    mlx: { engineInstalled: false, videoEngineInstalled: false, installedImages: [], installedVideos: [] },
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: /^Settings$/ }).click()
  await page.getByRole('button', { name: /AI Backends/i }).click()

  // The Mac gets the MLX installer where other platforms get the ComfyUI panel.
  const section = page.getByRole('button', { name: /Local Media \(Apple MLX\)/i })
  await expect(section).toBeVisible({ timeout: 15_000 })
  await section.click()
  await expect(page.getByRole('button', { name: /ComfyUI/i })).toHaveCount(0)

  // Engine first: a model can't install without it.
  await expect(page.getByText(/about 3 GB of Python packages/i)).toBeVisible()
  await page.getByRole('button', { name: /Install engine/i }).first().click()
  await expect(page.getByText(/^Installed/).first()).toBeVisible({ timeout: 20_000 })

  // Then a model — the catalog row flips to installed and offers Remove.
  await page.getByRole('button', { name: /^Install$/ }).first().click()
  await expect(page.getByRole('button', { name: /Remove/i }).first()).toBeVisible({ timeout: 20_000 })

  const calls = (await mlxCalls(page)) as any[]
  expect(calls.some((c) => c.cmd === 'mlx_image_install_model' && c.id === 'sd-turbo')).toBe(true)
})

test('windows local is unchanged: ComfyUI lanes still offered', async ({ page }) => {
  // Guard against fixing the Mac by breaking everyone else.
  await bootLocalCreate(page, { ...MAC_OPTS, platform: 'windows' })

  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: 'Remove Background', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Edit / Image to Image', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Animate Image', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Music', exact: true })).toBeVisible()
})
