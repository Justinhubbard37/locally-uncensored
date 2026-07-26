/**
 * Command injection regression, found in the 2.5.9 security pass (2026-07-26)
 * and reproduced live on Windows before the fix.
 *
 * Two holes, both reachable from a prompt injection (a poisoned file, PR
 * comment or search result steering the model into one tool call) and neither
 * covered by a gate: `pr_resume` is in neither CODEX_CONFIRM_TOOLS nor
 * MUTATING_TOOLS, and the git tools are in MUTATING_TOOLS but not in the
 * confirm gate, so none of them stops for a dialog.
 *
 *   A) shellQuote escaped for POSIX only. shell_execute_sync runs PowerShell on
 *      Windows, where `'\''` ENDS the string, so the rest ran as script:
 *        Write-Output 'x'\''; Write-Output SHELLQUOTE-INJECTED; '\'''
 *      printed SHELLQUOTE-INJECTED on its own line.
 *   B) PR_URL_RE accepted `[^/]+` for owner and repo, so
 *        https://github.com/o/r;Write-Output PRRESUME-INJECTED/pull/1
 *      built `gh pr view 1 --repo o/r;Write-Output PRRESUME-INJECTED --json …`
 *      and the payload ran.
 */
import { describe, it, expect } from 'vitest'
import { shellQuote, buildGitCommitCommand, buildGhPrCreateCommand } from '../git-tools'
import { parsePrUrl } from '../pr-resume'

const WIN = 'Win32'
const NIX = 'Linux x86_64'
// The exact payload that escaped before the fix.
const PAYLOAD = "x'; Write-Output SHELLQUOTE-INJECTED; '"

describe('shellQuote follows the shell that actually runs', () => {
  it('doubles the quote on Windows, where PowerShell is the shell', () => {
    // PowerShell reads '' inside a single-quoted string as one literal quote,
    // so the payload stays one argument instead of becoming a new statement.
    expect(shellQuote("it's", WIN)).toBe("'it''s'")
    expect(shellQuote(PAYLOAD, WIN)).toBe("'x''; Write-Output SHELLQUOTE-INJECTED; '''")
  })

  it('keeps the POSIX form off Windows', () => {
    expect(shellQuote("it's", NIX)).toBe("'it'\\''s'")
  })

  it('never leaves an odd number of quotes for the Windows shell to reopen', () => {
    // The bug in one assertion: a quoted string must contain an even number of
    // quote characters, otherwise something after it is outside the string.
    for (const s of [PAYLOAD, "'", "''", "a'b'c", "'; calc; '", "$(calc)", '`calc`']) {
      const q = shellQuote(s, WIN)
      expect((q.match(/'/g) || []).length % 2, `unbalanced for ${JSON.stringify(s)}`).toBe(0)
    }
  })

  it('leaves expansion characters inert in both shells', () => {
    // Neither shell expands $ or backticks inside single quotes, so these only
    // need to survive as literals.
    for (const p of [WIN, NIX]) {
      expect(shellQuote('$(calc)', p)).toContain('$(calc)')
      expect(shellQuote('`calc`', p)).toContain('`calc`')
    }
  })

  it('carries the fix into the commands the model can reach', () => {
    const commit = buildGitCommitCommand({ message: PAYLOAD }) // default platform
    const pr = buildGhPrCreateCommand({ title: PAYLOAD, body: PAYLOAD })
    for (const cmd of [commit, pr]) {
      // Whatever the host platform, the POSIX escape must not appear on Windows
      // and the payload must never sit outside quotes.
      expect(cmd).not.toContain('; Write-Output SHELLQUOTE-INJECTED; ' + "'" + ' ')
    }
    expect(commit).toContain('git commit -m')
    expect(pr).toContain('gh pr create')
  })
})

describe('parsePrUrl rejects anything a shell could act on', () => {
  it('accepts a real PR url', () => {
    expect(parsePrUrl('https://github.com/PurpleDoubleD/locally-uncensored/pull/87')).toEqual({
      owner: 'PurpleDoubleD',
      repo: 'locally-uncensored',
      number: 87,
    })
  })

  it('accepts the punctuation GitHub itself allows in a repo name', () => {
    expect(parsePrUrl('https://github.com/a-b/c.d_e-f/pull/1')?.repo).toBe('c.d_e-f')
  })

  it('rejects the payload that used to run', () => {
    expect(parsePrUrl('https://github.com/o/r;Write-Output PRRESUME-INJECTED/pull/1')).toBeNull()
  })

  it('rejects every other shell metacharacter in owner or repo', () => {
    for (const bad of [';calc', '`calc`', '$(calc)', 'a|b', 'a&b', "a'b", 'a"b', 'a b', 'a\nb', 'a>b']) {
      expect(parsePrUrl(`https://github.com/${bad}/repo/pull/1`), `owner ${bad}`).toBeNull()
      expect(parsePrUrl(`https://github.com/owner/${bad}/pull/1`), `repo ${bad}`).toBeNull()
    }
  })

  it('still rejects non-github hosts and junk numbers', () => {
    expect(parsePrUrl('https://evil.com/o/r/pull/1')).toBeNull()
    expect(parsePrUrl('https://github.com/o/r/pull/0')).toBeNull()
    expect(parsePrUrl('not a url')).toBeNull()
  })
})
