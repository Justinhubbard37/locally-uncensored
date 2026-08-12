// Where a tooltip bubble goes, as plain arithmetic.
//
// The bubble used to be an absolutely positioned child of its trigger, so any
// ancestor with overflow-hidden cut it in half. The Native HiRes card is
// exactly such an ancestor, which is how #107 came in: the latent-upscale help
// text was readable for about two words. The bubble now lives in a portal on
// the body with fixed coordinates, and this function computes them. Keeping
// the maths out of the component is what makes it testable at all, since the
// suite runs without a DOM.

export interface Rect { top: number; left: number; width: number; height: number }
export interface Viewport { width: number; height: number }

export interface TooltipPlacement {
  top: number
  left: number
  /** Which side the bubble ended up on, after flipping away from an edge. */
  side: 'top' | 'bottom'
  /** Arrow offset inside the bubble, so it keeps pointing at the trigger. */
  arrowLeft: number
}

/** Breathing room between trigger and bubble, and between bubble and window. */
const GAP = 6
const MARGIN = 8
/** The arrow is 8px wide and rotated; keep it off the rounded corners. */
const ARROW_INSET = 10

export function tooltipPosition(
  trigger: Rect,
  bubble: { width: number; height: number },
  viewport: Viewport,
  preferred: 'top' | 'bottom',
): TooltipPlacement {
  // Flip only when the preferred side has no room AND the other side does.
  // Flipping into an even tighter edge would just move the problem.
  const roomAbove = trigger.top - GAP - MARGIN
  const roomBelow = viewport.height - (trigger.top + trigger.height) - GAP - MARGIN
  let side = preferred
  if (preferred === 'top' && bubble.height > roomAbove && roomBelow >= bubble.height) side = 'bottom'
  if (preferred === 'bottom' && bubble.height > roomBelow && roomAbove >= bubble.height) side = 'top'

  const top = side === 'top'
    ? trigger.top - GAP - bubble.height
    : trigger.top + trigger.height + GAP

  // Centre on the trigger, then pull back inside the window. A tooltip wider
  // than the window keeps the left margin rather than centring off-screen.
  const centre = trigger.left + trigger.width / 2 - bubble.width / 2
  const maxLeft = viewport.width - MARGIN - bubble.width
  const left = maxLeft < MARGIN ? MARGIN : Math.min(Math.max(centre, MARGIN), maxLeft)

  // The arrow follows the trigger even after the bubble was pushed sideways.
  const triggerCentre = trigger.left + trigger.width / 2
  const arrowLeft = Math.min(
    Math.max(triggerCentre - left, ARROW_INSET),
    Math.max(bubble.width - ARROW_INSET, ARROW_INSET),
  )

  return { top, left, side, arrowLeft }
}
