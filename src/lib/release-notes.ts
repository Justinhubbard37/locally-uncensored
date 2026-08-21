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
    version: '2.6.6',
    headline: 'Agent and Code mode do the same work for fewer credits',
    lines: [
      'Agent and Code mode send far less context on every step, so every step costs fewer credits. Old tool results shrink as the run goes on, the amount sent per step is capped, and the stable part of the prompt stays put so the upstream cache keeps paying off. The coding tool list alone is meaningfully leaner.',
      'A run no longer quietly re-reads and re-sends the same big files forever, and an agent run stopped firing a hidden memory step on every single round. Same result, smaller bill, and the long runs are where you feel it.',
      'Plain chat, group chat and A/B compare now cap how much history they send to paid models, so a long conversation stops getting more expensive without you noticing. A group round still costs one bill per model, and the composer says so.',
      'Anthropic models sent with your own key now use prompt caching, so a follow up on the same conversation is cheaper than starting it cold.',
      'The Code view grew a mode menu per conversation (Ask, Bypass, Plan mode), the plan moved into the right panel, and a real file explorer arrived that you can widen and preview files in without leaving the app.',
    ],
    details: [
      {
        title: 'Local',
        items: [
          'Agent and Code runs trim older tool results out of what they send upstream. The newest step is always kept in full, so the model never edits against something it can no longer see, and a setting turns the whole thing off if a run ever misbehaves.',
          'The context sent on a paid step is capped, and the meter now counts against that cap instead of the whole model window, so the warning fires before a step gets expensive rather than after.',
          'The stable half of the prompt no longer changes every step. The minute clock and everything else that moves each turn sit at the end now, so the upstream cache survives a long run instead of going cold on a timestamp.',
          'The coding tool catalog is leaner: the git and gh cookbook, paragraphs the system prompt already states, and the PR and delegate tools all left the every-step budget, and the image and video tools share one settings schema.',
          'A mode menu in the Code composer picks Ask permissions, Bypass permissions or Plan mode per conversation, with a global default in Settings. Bypass never lifts the cloud shell lock, and the menu says so.',
          'Plan mode explores read only, writes the plan, then stops for your yes. Approve and run carries the whole plan out in the same run and never lands in Bypass on its own: the button shows the mode it will run in, and it shows you the real commands first.',
          'The plan moved out of the prompt box into the right panel, live above the files.',
          'The file explorer is a real tree you expand folder by folder, widen by dragging its edge, with the width remembered across a restart. Click a file to preview it: code with highlighting, images inline, HTML in a sandboxed frame with scripts off until you ask. node_modules, .git, target and dist stay out of the way.',
          'A follow up in the same conversation stops re-attaching images from many messages back, so old pictures no longer ride along on every later step where nothing looks at them.',
        ],
      },
      {
        title: 'Cloud',
        items: [
          'Anthropic models sent with your own key carry prompt caching markers on the system block, the last tool and the last stable message, so a repeated request reads from the cache instead of paying for the whole prompt again.',
          'The automatic memory step on LU Cloud only runs if you turn it on, and then on the cheapest capable model rather than the one you are chatting with, and at most every third turn. It used to run on the model you were chatting with, on every single round, whether you wanted it or not.',
          'Group chat and A/B compare cap the history they send per model, the same as a normal chat, instead of sending the full shared thread to every model on every round.',
        ],
      },
    ],
  },
  {
    version: '2.6.5',
    headline: 'Updating works again, and the work you started survives it',
    lines: [
      'The installer used to stop at our own running engine and roll the whole update back, so the app could not be updated at all without killing the process by hand. That is fixed, and it is the reason to install this build.',
      'In Code mode an approved change actually lands now, or says exactly why it cannot, and anything still waiting for your yes survives a restart. Installing an update is a restart, so this used to throw away the work it was meant to rescue.',
      'Create tells the truth about what it is doing: Download and install finishes instead of freezing on "Refreshing the model list", the gallery reports the seed you really rendered with, help tooltips are readable, and the Music tab stops quoting cloud prices at local users.',
      'Dropping files into the app works again on Windows, the trainer repairs its own environment, FramePack stops producing mush, and an AMD card shows up without the ROCm tools installed.',
      'Your own LoRAs are selectable in image generation, a broken ComfyUI Python environment rebuilds itself instead of showing a wall of errors, and a conversation with the built in engine survives a render that needs the video memory.',
      'Models you already have in Ollama or LM Studio come along with one click and no re-download, and the ComfyUI environment now installs a torch its current core actually accepts.',
    ],
    details: [
      {
        title: 'Local',
        items: [
          'The installer shuts our engine down before writing, instead of rolling the update back at a locked llama-server.exe.',
          'An approved change lands, or names the conflict. Changes waiting for approval are kept across a restart, and the plan bar no longer claims to be finished while writes are still queued.',
          'A request the model server refuses ends the run at once with the reason, instead of being retried twice while the run looks alive.',
          'Dragging files onto the Character Studio board, the chat composer or the RAG panel works again on Windows.',
          'Download and install waits for ComfyUI to actually list the new model, counts the seconds, restarts the engine once if the scan stalls, and explains itself if that still does not help.',
          'The LoRA section in image generation is always there on lanes that support it. Empty, it names the folder to drop files into and offers Rescan, so a LoRA added while the app runs shows up without a restart. Characters from the trainer land there by themselves.',
          'A ComfyUI Python environment that dies at import is recognised as broken and rebuilt into its own venv, from Create automatically and from Settings with Repair environment. Re-running the installer never fixed this, because pip saw every package as already there.',
          'A chat with the built in engine survives an image or video render. The engine used to be left out of the memory juggling entirely, and a restart meant re-reading the whole conversation. Its state is now parked on disk and restored afterwards.',
          'Character training repairs its own environment instead of refusing to start, and FramePack got back the VAE it was trained with.',
          'Cancel in Character Studio stops the training itself, not just the launcher above it. The two processes holding the card at full load used to keep running until they were killed by hand.',
          'A repair that cannot finish says why in one sentence, a full disk for example, and stops reporting the environment as ready.',
          'The starter bundle offered on a lane is one that lane can actually run, and its card stays up until the last file has landed, so nothing is pickable while it is still downloading.',
          'A release that was withdrawn stops being advertised as an available update.',
          'An AMD card is listed even without the ROCm command line tools, and says plainly what could not be verified.',
          'The gallery reports the seed the image was really made with, so a run can be repeated.',
          'Help tooltips float above the window instead of being clipped to two words, everywhere in the app.',
          'The Music tab in local mode has no canvas, no per-second billing line, and always takes your lyrics.',
          'The benchmark has a brake for a model that goes off script, and the board says what it ranks.',
          'Settings, Model Storage, Scan for local models finds the GGUFs that Ollama and LM Studio already store and links them into the Built-in Engine without copying, so the disk pays once and both apps keep working.',
          'The ComfyUI environment installs torch from the living cu126 channel. The frozen cu121 channel stops at torch 2.5.1, which the current ComfyUI core rejects at import, so a fresh setup or a repair used to build an environment that could not start. Blackwell cards keep cu128.',
          'While an environment rebuilds, the spinner reports what is downloading, how big it is, how fast it moves and how long is left, instead of sitting silent for minutes.',
        ],
      },
      {
        title: 'Cloud',
        items: [
          'Turning thinking off now turns it off on servers you configure yourself, not just here.',
          'Running out of credits says so immediately and offers the top up, instead of retrying a request that cannot succeed.',
          'A coding step no longer carries the image and video generators unless the task asks for them, which is about a third of the tool budget on every step.',
        ],
      },
    ],
  },
  {
    version: '2.6.4',
    headline: 'What you see is what you pay',
    lines: [
      'Cloud off means cloud off: with no local model running, the switch used to keep the cloud model silently active and chats kept billing credits. The app now refuses any model from the wrong mode.',
      'The music price in the picker follows the length slider live. Billing was always per second, but the label quoted 1 minute, so a 3 minute song looked three times cheaper than it was.',
    ],
  },
  {
    version: '2.6.3',
    headline: 'Agent runs you can trust, and a lighter, faster app',
    lines: [
      'Agent and Code mode got a deep reliability pass: runs no longer stall, loop, or invent results, small local models drive tools properly, and Stop always stops.',
      'New: group chat with 2 to 4 local models, editable model answers, Wan native video sizes, HiRes fix, and RTX 50 support for character training.',
      'Cloud: personal API keys for the OpenAI compatible endpoint, your own lyrics really get sung, and every model shows its price up front.',
      'Long chats got a deep memory fix, streaming stays smooth, and generated images survive a restart.',
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
          'Character training supports RTX 50 cards, and a broken trainer environment says so before the run starts.',
          'A ComfyUI that dies at startup shows the real reason instead of reinstalling in a loop.',
          'Read aloud plays again; our own security policy had blocked it.',
          'The benchmark measures cost and correctness, and answers that were cut off are marked, in the benchmark and in chat.',
          'Long chats got a deep memory fix, generated images survive a restart, and the remote tab is named AI Terminal.',
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
