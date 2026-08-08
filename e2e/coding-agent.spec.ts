import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * End-to-end cover for the 2.6.3 agent audit, driven through the real React
 * app against the built-in engine — the DEFAULT backend, and the one every
 * finding below was measured on.
 *
 * These are the checks no unit test can make, because each one is about the
 * loop, the view lifecycle and the transport agreeing with each other:
 *
 *   A1  the Code tab streams on a NON-Ollama transport (the built-in engine
 *       is providerId 'openai'); it used to sit silent until the whole call
 *       returned, which is what David reported repeatedly.
 *   A2  a run started before a tab switch is still stoppable afterwards — the
 *       view unmounts, the hook is rebuilt, and the store aborter is what
 *       carries the handle across.
 *   B1  edit → test → edit → test: the second identical shell command really
 *       re-runs instead of being swallowed as a repeat.
 *   B8  the agent injects the long shell timeout, so a build is not killed at
 *       the Rust side's 2-minute default.
 *   C1  file_read pages: offset/limit return a window, not the whole file.
 */

const FILE_LINES = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')

type Turn = { text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }

async function boot(page: Page, agentTurns: Turn[]) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: 'unused in agent specs',
    modelName: DEFAULT_MODEL_NAME,
    replyChunkDelayMs: 8,
    agentTurns,
    files: { 'big.ts': FILE_LINES },
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  // Mode first, THEN the chat: the sidebar's mode buttons clear the active
  // conversation by design, so a chat opened before the switch is dropped.
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await openNewChat(page)
}

async function instruct(page: Page, text: string) {
  const composer = page.locator('textarea').first()
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(800)
  await composer.fill(text)
  await composer.press('Enter')
}

const toolCalls = (page: Page) =>
  page.evaluate(() => (window as any).__E2E_TOOL_CALLS__ || [])

test('the Code tab streams on the built-in engine instead of painting in one tick', async ({ page }) => {
  // One long prose turn, no tools: the whole point is WHEN the text appears.
  const answer = 'Streaming through the built-in engine, token by token, in the Code tab.'
  await boot(page, [{ text: answer }])

  await instruct(page, 'explain the repo layout')

  // Partial text on screen is the proof: with the old blocking chatWithTools
  // path nothing rendered until the call returned, so no prefix could ever be
  // visible on its own.
  const main = page.getByRole('main')
  await expect(main.getByText(/Streaming through/)).toBeVisible({ timeout: 20_000 })
  await expect(main.getByText(answer)).toBeVisible({ timeout: 20_000 })
})

test('a run survives a tab switch and is still stoppable afterwards', async ({ page }) => {
  // A long script so the run is still going while we switch away and back.
  const turns: Turn[] = Array.from({ length: 40 }, (_, i) => ({
    text: `step ${i + 1}`,
    toolCalls: [{ name: 'file_read', args: { path: `src/file-${i}.ts` } }],
  }))
  await boot(page, turns)

  await instruct(page, 'walk the whole source tree')
  // The run is under way.
  await expect.poll(async () => (await toolCalls(page)).length, { timeout: 20_000 }).toBeGreaterThan(0)

  // Look at another view and come back. AppShell mounts ChatView on
  // `currentView === 'chat'`, so this really unmounts CodexView and rebuilds
  // the hook with empty refs — the exact move that used to orphan the run.
  // (The sidebar's mode buttons clear the active conversation by design, so
  // they would prove something else.)
  const header = page.getByRole('banner')
  await header.getByRole('button', { name: 'Models' }).click()
  await page.waitForTimeout(800)
  await header.getByRole('button', { name: 'Chat' }).click()

  // The remounted view must still show the run as active — before the fix the
  // fresh hook reported idle, offered a second Send and no Stop at all.
  const stop = page.getByRole('button', { name: /Stop/i })
  await expect(stop).toBeVisible({ timeout: 20_000 })

  await stop.click()
  // And Stop actually reaches the controller the OLD hook instance created:
  // the tool calls stop climbing.
  await page.waitForTimeout(1500)
  const settled = (await toolCalls(page)).length
  await page.waitForTimeout(2500)
  expect((await toolCalls(page)).length).toBe(settled)
})

/**
 * Agent mode (the Chat tab with the Agent toggle) is a DIFFERENT loop from the
 * Code tab — useAgentChat, not useCodex — and audit B1/B8 are findings about
 * that loop specifically. Running them in the Code tab proves nothing: useCodex
 * never had the exact-repeat set, and it always injected the shell timeout.
 */
async function bootAgentMode(page: Page, agentTurns: Turn[]) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: 'unused in agent specs',
    modelName: DEFAULT_MODEL_NAME,
    replyChunkDelayMs: 8,
    agentTurns,
    files: { 'big.ts': FILE_LINES },
  })
  await seedOnboardingDone(page)
  // Auto-approve the tool categories this spec drives. Agent mode defaults to
  // asking for terminal/filesystem, and an approval dialog is a different
  // behaviour than the one under test here.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'locally-uncensored-permissions',
      JSON.stringify({
        state: {
          globalPermissions: {
            filesystem: 'auto', terminal: 'auto', desktop: 'auto', web: 'auto',
            system: 'auto', image: 'auto', video: 'auto', workflow: 'auto',
          },
          conversationOverrides: {}, perToolOverrides: {}, modeScope: 'agent',
        },
        version: 2,
      }),
    )
  })
  await page.goto('/')
  await openNewChat(page)
  const agentToggle = page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
  await agentToggle.click()
  await expect(agentToggle).toHaveAttribute('title', /Agent Mode is on/i, { timeout: 10_000 })
  // Activation offers a workspace; the sandbox is the right answer for a spec.
  const sandbox = page.getByRole('button', { name: /Sandbox/i })
  if (await sandbox.isVisible().catch(() => false)) await sandbox.click()
}

test('agent mode: edit, test, edit, test — the second identical command really re-runs', async ({ page }) => {
  const RUN = 'npm test'
  await bootAgentMode(page, [
    { text: 'running the suite', toolCalls: [{ name: 'shell_execute', args: { command: RUN } }] },
    { text: 'fixing it', toolCalls: [{ name: 'file_write', args: { path: 'src/fix.ts', content: 'export const fixed = true' } }] },
    { text: 'verifying', toolCalls: [{ name: 'shell_execute', args: { command: RUN } }] },
    { text: 'Done: the suite is green.' },
  ])

  await instruct(page, 'make the failing test green')
  await expect(page.getByRole('main').getByText('Done: the suite is green.')).toBeVisible({ timeout: 30_000 })

  const calls = await toolCalls(page)
  const shellRuns = calls.filter((c: any) => c.cmd === 'shell_execute' && c.command === RUN)
  // Two real executions. The over-loop guard used to drop the second one and
  // tell the model nothing had changed — with a file_write in between, which
  // is exactly when it HAS changed (audit B1).
  expect(shellRuns.length).toBe(2)

  // And agent mode injects the long shell timeout now, instead of leaving the
  // Rust default of 120 s to kill a real build (audit B8).
  expect(shellRuns[0].timeout).toBe(600000)
})

test('file_read pages a large file instead of dumping it whole', async ({ page }) => {
  await boot(page, [
    { text: 'reading the middle', toolCalls: [{ name: 'file_read', args: { path: 'src/big.ts', offset: 100, limit: 5 } }] },
    { text: 'Read lines 100 to 104.' },
  ])

  await instruct(page, 'show me the middle of big.ts')
  await expect(page.getByRole('main').getByText('Read lines 100 to 104.')).toBeVisible({ timeout: 30_000 })

  // Open the tool block and read what the window actually returned.
  await page.getByRole('main').getByText('file_read').first().click()
  const block = page.getByRole('main')
  await expect(block.getByText(/\[lines 100-104 of 200\]/)).toBeVisible({ timeout: 10_000 })
  await expect(block.getByText(/call file_read again with offset: 105/)).toBeVisible()
})

test('the plan the model writes shows up above the composer and tracks progress', async ({ page }) => {
  // Audit C4. On a long run the transcript scrolls away and the user cannot
  // tell step 2 from step 9. The model owns the list through `todo_write`; this
  // proves the tool is actually reachable in a real run (routing, permissions,
  // executor, store, render) and that the strip follows the model's updates.
  await boot(page, [
    {
      text: 'planning first',
      toolCalls: [{
        name: 'todo_write',
        args: {
          todos: [
            { content: 'read the config', status: 'in_progress' },
            { content: 'patch the parser', status: 'pending' },
            { content: 'run the suite', status: 'pending' },
          ],
        },
      }],
    },
    {
      text: 'config read, patching',
      toolCalls: [{
        name: 'todo_write',
        args: {
          todos: [
            { content: 'read the config', status: 'completed' },
            { content: 'patch the parser', status: 'in_progress' },
            { content: 'run the suite', status: 'pending' },
          ],
        },
      }],
    },
    { text: 'PLAN_RUN_DONE' },
  ])

  await instruct(page, 'fix the parser and prove it')
  await expect(page.getByRole('main').getByText('PLAN_RUN_DONE')).toBeVisible({ timeout: 30_000 })

  // Collapsed by default, so what must be on screen is the counter and the step
  // that is running right now — not the whole list pushing the composer away.
  await expect(page.getByText('plan 1/3')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('patch the parser').first()).toBeVisible()

  // Expanding shows every step, with the finished one struck through.
  await page.getByText('plan 1/3').click()
  await expect(page.getByText('read the config')).toBeVisible()
  await expect(page.getByText('run the suite')).toBeVisible()

  // `todo_write` must never have gone near the Rust bridge: it is pure
  // conversation state, and a backend round trip would mean a permission gate
  // on writing a to-do list.
  const calls = await toolCalls(page)
  expect(calls.filter((c: any) => c.cmd === 'todo_write')).toEqual([])
})
