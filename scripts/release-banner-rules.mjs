/**
 * Which releases carry the "old release" banner.
 *
 * Pulled out of mark-old-releases.mjs so the rule can be tested without a
 * GitHub token. The script itself is a top-level-await program that talks to
 * the API on import, and the rule is the only part that can be wrong quietly.
 */

export const MARKER = '<!-- lu-old-release-banner -->'

export const BANNER =
  MARKER +
  '\n> **This is an old release.** Get the current version from the ' +
  '[latest release](https://github.com/PurpleDoubleD/locally-uncensored/releases/latest), ' +
  'or download the Windows installer straight from ' +
  '[lu-labs.ai](https://lu-labs.ai/api/download/windows). ' +
  'Older builds miss fixes and features, and some of them predate the Cloud.\n\n'

/** Strips a banner wherever it sits, so re-running never stacks them. */
export function withoutBanner(body) {
  const at = (body ?? '').indexOf(MARKER)
  if (at < 0) return body ?? ''
  const end = (body ?? '').indexOf('\n\n', at)
  return end < 0 ? '' : (body ?? '').slice(0, at) + (body ?? '').slice(end + 2)
}

const stamp = (rel) => Date.parse(rel?.published_at ?? rel?.created_at ?? '') || 0

/**
 * True when this release should carry the banner.
 *
 * `/releases/latest` is the release flagged Latest, which is a deliberate
 * choice (we publish as a prerelease and flip it once verified), not simply the
 * newest. So "not Latest" is NOT the same as "old": a release we published
 * five minutes ago is not Latest yet either, and the old rule stamped it "This
 * is an old release" the moment it appeared. The Discord announcement then
 * quotes that body, so the release everyone was waiting for announced itself as
 * obsolete (review 2026-08-14).
 *
 * A prerelease or draft that is at least as new as the current Latest is the
 * upcoming one and stays clean. Everything older still gets the banner,
 * including a prerelease that was superseded, because that one really is old.
 */
export function shouldCarryBanner(rel, latest) {
  if (!latest || rel.id === latest.id) return false
  const upcoming = (rel.prerelease === true || rel.draft === true) && stamp(rel) >= stamp(latest)
  return !upcoming
}
