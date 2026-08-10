// Client-side signal for LU Cloud's `code: 'credits_exhausted'` (out of
// credits, top-up wallet empty). Any request layer that spots the code fires
// ONE window event; the globally mounted CreditsExhaustedModal turns it into
// the "Load up your credits" dialog instead of a dead-end chat error. An
// event (not a store) so the non-React provider layer can raise it without
// new dependencies.

export const CREDITS_EXHAUSTED_EVENT = 'lu:credits-exhausted'

/** Where the dialog's button leads. Purchases happen on the website. */
export const TOPUP_URL = 'https://lu-labs.ai/credits'

export function signalCreditsExhausted(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CREDITS_EXHAUSTED_EVENT))
  }
}

/**
 * What the transcript says. The dialog above opens on top of the answer, but a
 * dismissed dialog leaves nothing behind, and on a long agent run the last line
 * in the chat is the only thing the user still reads minutes later (Morgan,
 * 2026-08-10: an out-of-credits run read as "it is still cycling"). Every
 * surface renders this instead of a generic error line.
 */
export const CREDITS_EXHAUSTED_MESSAGE =
  "You're out of credits, so the server refused this request.\n\n" +
  'Plan credits refill on your renewal date. Top-up credits are one-time, never ' +
  'expire, and are only used once the plan credits are gone. Load up at ' +
  TOPUP_URL +
  '.'
