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
