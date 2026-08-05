/**
 * What is new in this version, shown once after an update (B4, David 2026-08-04).
 *
 * New models land weekly and the catalogue is server-driven, so a shipped build
 * gains capability without anyone noticing. This is the one place that tells the
 * user what changed, once per version, and then never again.
 *
 * The rule that keeps it honest: a version with NO entry here shows NO popup.
 * An empty sheet is worse than no sheet, and a release whose notes nobody wrote
 * should simply stay quiet rather than greet the user with a headline and
 * nothing under it.
 */

export interface ReleaseNote {
  /** Exact version string, matched against package.json. */
  version: string
  /** One line the user reads first. */
  headline: string
  /** Two to five short lines. Anything longer stops being read. */
  lines: string[]
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '2.6.3',
    headline: 'Sharper measurements, and an agent that can reach your desktop',
    lines: [
      'The benchmark now shows what a model actually costs: tokens spent, how much of that went into thinking, and whether the answer was right. Two models that tie on speed rarely tie here.',
      'A run that hit its token limit is marked as cut off, so a truncated answer is no longer blamed on the model.',
      'The agent can open a folder or start a program when you ask it to.',
      'Read aloud works again under the strict content policy, and ComfyUI says why it failed to start instead of going quiet.',
    ],
  },
]

/** The note for a version, or undefined when nobody wrote one. */
export function releaseNoteFor(version: string): ReleaseNote | undefined {
  return RELEASE_NOTES.find((n) => n.version === version)
}
