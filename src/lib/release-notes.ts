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
    headline: 'Agent runs you can trust, and a lighter, faster app',
    lines: [
      'Agent and Code mode got a deep reliability pass: runs no longer stall, loop, or invent results, small local models drive tools properly, and Stop always stops.',
      'Long chats stopped eating memory, streaming stays smooth, and generated images now survive a restart.',
      'Every cloud model shows its price up front, and the credits meter counts video and training budgets truthfully.',
      'The benchmark measures cost and correctness, not just speed, and marks answers that were cut off.',
      'New: native HiRes fix for local image generation, and the agent opens folders and programs on request.',
    ],
  },
]

/** The note for a version, or undefined when nobody wrote one. */
export function releaseNoteFor(version: string): ReleaseNote | undefined {
  return RELEASE_NOTES.find((n) => n.version === version)
}
