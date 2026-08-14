/**
 * The release everyone is waiting for must not announce itself as obsolete.
 *
 * Found by the review of the D1 prerelease fix (2026-08-14). `/releases/latest`
 * returns the release flagged Latest, and we publish as a prerelease and flip
 * that flag only after verifying the build. So on the day 2.6.5 goes out it is
 * NOT latest, the old rule read that as "old", and the brand-new release got
 * "This is an old release" stamped on it within a minute of appearing. The
 * Discord announcement quotes the release body, so the banner would have gone
 * out with the announcement.
 *
 * Run: npx vitest run src/lib/__tests__/release-banner-rules.test.ts
 */
import { describe, it, expect } from 'vitest'
import { shouldCarryBanner, withoutBanner, BANNER, MARKER } from '../../../scripts/release-banner-rules.mjs'

const rel = (over: Record<string, unknown> = {}) => ({
  id: 1, tag_name: 'v1', prerelease: false, draft: false,
  published_at: '2026-08-01T00:00:00Z', body: '', ...over,
})

const latest = rel({ id: 100, tag_name: 'v2.6.4', published_at: '2026-08-10T00:00:00Z' })

describe('what counts as an old release', () => {
  it('the one flagged Latest never carries it', () => {
    expect(shouldCarryBanner(latest, latest)).toBe(false)
  })

  it('a shipped older release carries it', () => {
    const old = rel({ id: 2, tag_name: 'v2.5.10', published_at: '2026-07-01T00:00:00Z' })
    expect(shouldCarryBanner(old, latest)).toBe(true)
  })

  it('THE case: a fresh prerelease published after Latest stays clean', () => {
    const fresh = rel({
      id: 3, tag_name: 'v2.6.5', prerelease: true, published_at: '2026-08-14T09:00:00Z',
    })
    expect(shouldCarryBanner(fresh, latest)).toBe(false)
  })

  it('a draft published after Latest stays clean too', () => {
    const draft = rel({
      id: 4, tag_name: 'v2.6.6', draft: true, published_at: '2026-08-14T09:00:00Z',
    })
    expect(shouldCarryBanner(draft, latest)).toBe(false)
  })

  it('a prerelease that was superseded really is old and carries it', () => {
    const stale = rel({
      id: 5, tag_name: 'v2.6.2-rc', prerelease: true, published_at: '2026-07-20T00:00:00Z',
    })
    expect(shouldCarryBanner(stale, latest)).toBe(true)
  })

  it('a prerelease published the same instant as Latest counts as upcoming', () => {
    const tie = rel({ id: 6, prerelease: true, published_at: latest.published_at })
    expect(shouldCarryBanner(tie, latest)).toBe(false)
  })

  it('a missing date does not silently stamp the newest release', () => {
    // Date.parse of undefined is NaN, which would compare false against
    // everything. A release with no usable date is treated as old, which is
    // the safe direction for a shipped build, and the fresh one keeps its
    // published_at anyway.
    const undated = rel({ id: 7, prerelease: true, published_at: null, created_at: null })
    expect(shouldCarryBanner(undated, latest)).toBe(true)
  })
})

describe('the banner text itself', () => {
  it('stripping is idempotent, so a re-run never stacks two', () => {
    const body = BANNER + 'real notes\n'
    expect(withoutBanner(body)).toBe('real notes\n')
    expect(withoutBanner(withoutBanner(body))).toBe('real notes\n')
  })

  it('a body without one is returned untouched', () => {
    expect(withoutBanner('just notes')).toBe('just notes')
    expect(withoutBanner(undefined)).toBe('')
  })

  it('carries the marker the script looks for', () => {
    expect(BANNER.startsWith(MARKER)).toBe(true)
  })
})
