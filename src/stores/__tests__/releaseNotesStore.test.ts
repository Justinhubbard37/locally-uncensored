/**
 * B4 (David 2026-08-04): "what is new" once per VERSION.
 *
 * The whole feature is one decision, and it has exactly one trap: a null flag
 * means two different things. A fresh install has never stored one, and so does
 * anyone upgrading from a build that predates the store. Show the popup on both
 * and every new customer is greeted by release notes for software they have
 * never used. Suppress it on both and no upgrade ever sees it. So the rule
 * needs a second signal, and this file is where that is pinned down.
 *
 * Run: npx vitest run src/stores/__tests__/releaseNotesStore.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useReleaseNotesStore, shouldShowReleaseNotes } from '../releaseNotesStore'
import { RELEASE_NOTES, releaseNoteFor } from '../../lib/release-notes'

/** A version that really has notes, read from the table rather than hardcoded. */
const KNOWN = RELEASE_NOTES[0].version
const UNKNOWN = '9.9.9'

beforeEach(() => useReleaseNotesStore.setState({ lastNotesVersion: null }))

describe('the notes table', () => {
  it('has at least one entry, so the rest of this file means something', () => {
    expect(RELEASE_NOTES.length).toBeGreaterThan(0)
    expect(releaseNoteFor(KNOWN)).toBeDefined()
    expect(releaseNoteFor(UNKNOWN)).toBeUndefined()
  })

  it('every entry has a headline and at least two lines', () => {
    for (const n of RELEASE_NOTES) {
      expect(n.headline.trim().length, `${n.version}: headline`).toBeGreaterThan(10)
      expect(n.lines.length, `${n.version}: lines`).toBeGreaterThanOrEqual(2)
      for (const l of n.lines) expect(l.trim().length, `${n.version}: empty line`).toBeGreaterThan(0)
    }
  })

  it('no version appears twice', () => {
    const versions = RELEASE_NOTES.map((n) => n.version)
    expect(new Set(versions).size).toBe(versions.length)
  })
})

describe('shouldShowReleaseNotes', () => {
  it('shows for an upgrade from a build that had no store yet', () => {
    // The 2.6.2 to 2.6.3 case: onboarding was done long ago, the flag is null
    // because this store did not exist there.
    expect(shouldShowReleaseNotes(KNOWN, null, true)).toBe(true)
  })

  it('shows for an upgrade from a version whose notes were already read', () => {
    expect(shouldShowReleaseNotes(KNOWN, '2.6.0', true)).toBe(true)
  })

  it('does NOT show again once this version was seen', () => {
    expect(shouldShowReleaseNotes(KNOWN, KNOWN, true)).toBe(false)
  })

  it('does NOT show while onboarding is still running', () => {
    // This is the fresh-install guard. Onboarding owns the whole screen, and
    // finish() stamps the current version, so a new user never reaches the
    // "null means upgraded" branch above.
    expect(shouldShowReleaseNotes(KNOWN, null, false)).toBe(false)
  })

  it('stays quiet for a version nobody wrote notes for', () => {
    // A release that ships without notes shows no sheet rather than a headline
    // with nothing under it.
    expect(shouldShowReleaseNotes(UNKNOWN, null, true)).toBe(false)
    expect(shouldShowReleaseNotes(UNKNOWN, '2.6.0', true)).toBe(false)
  })
})

describe('the fresh-install sequence end to end', () => {
  it('a new user who finishes onboarding never sees the notes for that build', () => {
    const store = useReleaseNotesStore.getState()
    // Before onboarding finishes: nothing stored, nothing shown.
    expect(shouldShowReleaseNotes(KNOWN, useReleaseNotesStore.getState().lastNotesVersion, false)).toBe(false)
    // Onboarding.finish() does exactly this.
    store.markNotesSeen(KNOWN)
    // Now onboarded, and the sheet stays down.
    expect(shouldShowReleaseNotes(KNOWN, useReleaseNotesStore.getState().lastNotesVersion, true)).toBe(false)
  })

  it('that same user DOES see the notes for the next version', () => {
    useReleaseNotesStore.getState().markNotesSeen(KNOWN)
    // Pretend the next build ships with its own entry.
    expect(useReleaseNotesStore.getState().lastNotesVersion).toBe(KNOWN)
    expect(shouldShowReleaseNotes(KNOWN, KNOWN, true)).toBe(false)
    // A different current version with notes would show; proven with the table
    // entry itself so this cannot pass on a typo.
    expect(shouldShowReleaseNotes(KNOWN, 'something-older', true)).toBe(true)
  })

  it('dismissing stamps the version so it does not return', () => {
    expect(shouldShowReleaseNotes(KNOWN, null, true)).toBe(true)
    useReleaseNotesStore.getState().markNotesSeen(KNOWN)
    expect(shouldShowReleaseNotes(KNOWN, useReleaseNotesStore.getState().lastNotesVersion, true)).toBe(false)
  })
})
