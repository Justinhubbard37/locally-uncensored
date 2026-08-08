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
 *
 * `lines` is the short read on the sheet. `details` sits behind the Show all
 * changes expander, grouped into sections (Local, Cloud), and may be long.
 */

export interface ReleaseNoteSection {
  title: string
  items: string[]
}

export interface ReleaseNote {
  /** Exact version string, matched against package.json. */
  version: string
  /** One line the user reads first. */
  headline: string
  /** Two to five short lines. Anything longer goes into `details`. */
  lines: string[]
  /** The full list behind the expander, grouped into sections. */
  details?: ReleaseNoteSection[]
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '2.6.3',
    headline: 'Agent runs you can trust, and a lighter, faster app',
    lines: [
      'Agent and Code mode got a deep reliability pass: runs no longer stall, loop, or invent results, small local models drive tools properly, and Stop always stops.',
      'New: group chat with 2 to 4 local models, editable model answers, Wan native video sizes, HiRes fix, and character training on RTX 50 cards.',
      'Cloud: personal API keys for the OpenAI compatible endpoint, your own lyrics really get sung, and every model shows its price up front.',
      'Long chats stopped eating memory, streaming stays smooth, and generated images survive a restart.',
    ],
    details: [
      {
        title: 'Local',
        items: [
          'Agent and Code runs no longer stall, loop, or invent results, and Stop always stops.',
          'A thinking-only round continues the run instead of ending it.',
          'Thinking streams in a small window between the steps, in order, and the plan bar stays out of the chat history.',
          'Small local models drive tools properly, including LM Studio and other OpenAI compatible local servers.',
          'The agent knows your OS and shell, and opens folders and starts programs on request.',
          'The agent context window sizes itself to what your server actually loaded.',
          'Group chat: pick 2 to 4 local models, they answer in turn in one conversation, every answer labeled.',
          'Edit any model answer in place; the conversation continues from your correction.',
          'Wan native video sizes: 480p in both orientations, a portrait or landscape flip, and ratio chips that keep the pixel budget.',
          'Native HiRes fix for local image generation.',
          'Character training works on RTX 50 cards, and a broken trainer environment says so before the run starts.',
          'A ComfyUI that dies at startup shows the real reason instead of reinstalling in a loop.',
          'Read aloud plays again; our own security policy had blocked it.',
          'The benchmark measures cost and correctness, and answers that were cut off are marked, in the benchmark and in chat.',
          'Long chats stopped eating memory, generated images survive a restart, and the remote tab is named AI Terminal.',
        ],
      },
      {
        title: 'Cloud',
        items: [
          'Personal API keys: mint keys in the account settings on lu-labs.ai and use your plan from Aider or any OpenAI compatible tool.',
          'Your own lyrics really get sung, with a how-to next to the lyrics box.',
          'Every cloud model shows its price up front in the picker.',
          'The credits meter counts video and training budgets truthfully.',
        ],
      },
    ],
  },
]

/** The note for a version, or undefined when nobody wrote one. */
export function releaseNoteFor(version: string): ReleaseNote | undefined {
  return RELEASE_NOTES.find((n) => n.version === version)
}
