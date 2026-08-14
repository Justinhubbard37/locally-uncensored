/**
 * The thinking downgrade must have something to drop.
 *
 * Both agent branches answer a 400 by resending without `thinking`. When the
 * turn never asked for thinking in the first place, that resend is byte for
 * byte the request that just failed: a second refusal, a second charge on the
 * cloud path, and a second wait for the user. useChat has guarded this since
 * it was written (`useThinking !== undefined`, useChat.ts:560); the agent path
 * never did (review 2026-08-14).
 *
 * Run: npx vitest run src/hooks/__tests__/agent-think-downgrade.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../useAgentChat.ts'), 'utf8',
)

describe('both branches check before they resend', () => {
  it('the ollama branch guards on the value it would drop', () => {
    expect(src).toContain(
      "if (chatOptions.thinking !== undefined\n" +
      "                  && (thinkErr?.message?.includes('does not support thinking')",
    )
  })

  it('the provider branch guards on its own', () => {
    expect(src).toContain(
      "if (streamOpts.thinking !== undefined\n" +
      "                  && (thinkErr?.message?.includes('does not support thinking')",
    )
  })

  it('no unguarded downgrade is left anywhere in the file', () => {
    const unguarded = src.match(
      /(?<!undefined\s*\n\s*&& \()if \(thinkErr\?\.message\?\.includes\('does not support thinking'\)/g,
    )
    expect(unguarded).toBeNull()
  })

  it('the guard names why, so nobody removes it as noise', () => {
    expect(src).toContain('Only worth a second attempt if there is something to drop')
    expect(src).toContain('useChat.ts:560')
  })
})
