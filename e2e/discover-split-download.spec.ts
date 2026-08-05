import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { openNewChat } from './support/ui'

/**
 * Sharded-GGUF download flow, end to end on the real UI (2.6.0, DeepSeek V4
 * Flash 0731). The catalog row is only a guess · the click must resolve the
 * repo's REAL file tree, warn about the multi-part size, and then start one
 * download per part into ONE folder (llama.cpp merges them there).
 *
 * The tree served by the mock is a byte-accurate snapshot of the live
 * HuggingFace API for unsloth/DeepSeek-V4-Flash-0731-GGUF (verified
 * 2026-08-01 via range-GETs: every file answers with GGUF magic and the
 * sizes below). So a green run proves the exact wiring a Windows/Linux
 * user hits: catalog card → tree resolve → 3-part confirm → per-part
 * download starts into the built-in engine's flat models dir.
 */

const REPO = 'unsloth/DeepSeek-V4-Flash-0731-GGUF'

// Live tree snapshot (files only trimmed to the GGUF payload + one metadata
// file · sizes are the real bytes, their sums are the catalog's 82.5/96.8/155 GB).
const TREE = [
  { type: 'file', path: 'config.json', size: 1734 },
  { type: 'file', path: 'UD-IQ1_S/DeepSeek-V4-Flash-0731-UD-IQ1_S-00001-of-00003.gguf', size: 5257664 },
  { type: 'file', path: 'UD-IQ1_S/DeepSeek-V4-Flash-0731-UD-IQ1_S-00002-of-00003.gguf', size: 49093726624 },
  { type: 'file', path: 'UD-IQ1_S/DeepSeek-V4-Flash-0731-UD-IQ1_S-00003-of-00003.gguf', size: 33440253504 },
  { type: 'file', path: 'UD-Q2_K_XL/DeepSeek-V4-Flash-0731-UD-Q2_K_XL-00001-of-00003.gguf', size: 5257664 },
  { type: 'file', path: 'UD-Q2_K_XL/DeepSeek-V4-Flash-0731-UD-Q2_K_XL-00002-of-00003.gguf', size: 49437013568 },
  { type: 'file', path: 'UD-Q2_K_XL/DeepSeek-V4-Flash-0731-UD-Q2_K_XL-00003-of-00003.gguf', size: 47390237120 },
  { type: 'file', path: 'UD-Q4_K_XL/DeepSeek-V4-Flash-0731-UD-Q4_K_XL-00001-of-00005.gguf', size: 5257408 },
  { type: 'file', path: 'UD-Q4_K_XL/DeepSeek-V4-Flash-0731-UD-Q4_K_XL-00002-of-00005.gguf', size: 48935523072 },
  { type: 'file', path: 'UD-Q4_K_XL/DeepSeek-V4-Flash-0731-UD-Q4_K_XL-00003-of-00005.gguf', size: 48980787136 },
  { type: 'file', path: 'UD-Q4_K_XL/DeepSeek-V4-Flash-0731-UD-Q4_K_XL-00004-of-00005.gguf', size: 49999168416 },
  { type: 'file', path: 'UD-Q4_K_XL/DeepSeek-V4-Flash-0731-UD-Q4_K_XL-00005-of-00005.gguf', size: 7174505088 },
]

// What the confirm dialog must show for the default (smallest) variant:
// 82,539,237,792 bytes → binary GB, one decimal.
const IQ1_TOTAL = 5257664 + 49093726624 + 33440253504
const IQ1_GB = +(IQ1_TOTAL / 1_073_741_824).toFixed(1) // 76.9

interface DlCall { url: string; destDir: string; filename: string; expectedBytes: number | null }

/** Download starts for THIS repo only — the built-in onboarding legitimately
 * starts the Qwen starter download through the same command first. */
async function dlCalls(page: Page): Promise<DlCall[]> {
  const all = (await page.evaluate(
    () => (window as unknown as { __E2E_DL_CALLS__?: unknown[] }).__E2E_DL_CALLS__ ?? [],
  )) as DlCall[]
  return all.filter(c => typeof c.url === 'string' && c.url.includes('DeepSeek-V4-Flash-0731-GGUF'))
}

/** Fresh install → built-in onboarding (the Windows/Linux default path), so
 * the active chat model is the managed engine and downloads route to its
 * flat models dir. Same walk as onboarding-builtin.spec. */
async function bootThroughBuiltinOnboarding(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    hfTree: { repo: REPO, entries: TREE },
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
  // The download flow below branches on the ACTIVE provider (built-in →
  // flat dir, LM Studio → <user>/<repo> nesting), and the active model is
  // only set once the async model list lands. Prove the managed engine is
  // live before touching Discover, or a slow machine tests the wrong branch.
  await openNewChat(page)
  await expect(page.getByText(/qwen2\.5-0\.5b/i).first()).toBeVisible()
}

test('0731 card resolves the real shard set, confirms 3 parts, starts all downloads into one dir', async ({ page }) => {
  await bootThroughBuiltinOnboarding(page)

  // Models page → Discover (default tab) → Mainstream (default sub-tab).
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  const card = page.getByText('DeepSeek V4 Flash 0731', { exact: false }).first()
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card.scrollIntoViewIfNeeded()

  // Default variant of the group is the smallest quant → IQ1, 82.5 GB.
  await page.getByTitle('Download 82.5 GB').click()

  // The click resolved the REAL tree (canned live snapshot) and must gate on
  // a confirm dialog naming the exact part count and binary size.
  await expect(page.getByText('Download split model')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/is split into/)).toContainText('3 files')
  await expect(page.getByText(new RegExp(`totalling.*${IQ1_GB} GB`))).toBeVisible()
  // 76.9 GB > 60 → the "too big for most GPUs" honesty line must show.
  await expect(page.getByText(/very large for a local model/i)).toBeVisible()

  await page.getByRole('button', { name: `Download 3 parts (${IQ1_GB} GB)` }).click()

  // One download per part, in order, all into the SAME flat built-in dir,
  // each with the true byte size from the tree (drives the tray's total).
  await expect.poll(async () => (await dlCalls(page)).length, { timeout: 15_000 }).toBe(3)
  const calls = (await dlCalls(page)) as DlCall[]
  const base = `https://huggingface.co/${REPO}/resolve/main/UD-IQ1_S/DeepSeek-V4-Flash-0731-UD-IQ1_S`
  expect(calls.map(c => c.url)).toEqual([
    `${base}-00001-of-00003.gguf`,
    `${base}-00002-of-00003.gguf`,
    `${base}-00003-of-00003.gguf`,
  ])
  expect(new Set(calls.map(c => c.destDir)).size).toBe(1)
  expect(calls[0].destDir).toBe('/tmp/lu-e2e/models')
  expect(calls.map(c => c.expectedBytes)).toEqual([5257664, 49093726624, 33440253504])

  // The dialog is gone — no second confirm, no error banner.
  await expect(page.getByText('Download split model')).toHaveCount(0)
  await expect(page.getByText(/Download failed/)).toHaveCount(0)
})

test('cancel in the split confirm starts nothing', async ({ page }) => {
  await bootThroughBuiltinOnboarding(page)
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await expect(page.getByText('DeepSeek V4 Flash 0731', { exact: false }).first()).toBeVisible({ timeout: 15_000 })
  await page.getByTitle('Download 82.5 GB').click()
  await expect(page.getByText('Download split model')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('Download split model')).toHaveCount(0)
  expect(await dlCalls(page)).toHaveLength(0)
})
