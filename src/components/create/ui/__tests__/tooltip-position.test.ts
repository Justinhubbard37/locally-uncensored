// Regression guard for #107: the latent-upscale help text was clipped by the
// Native HiRes card, which carries overflow-hidden. The bubble is portalled to
// the body now, so these coordinates are the whole placement logic.
import { describe, it, expect } from 'vitest'
import { tooltipPosition } from '../tooltip-position'

const VIEW = { width: 1280, height: 800 }
const BUBBLE = { width: 220, height: 60 }
// A 12px help icon somewhere in the middle of the panel.
const ICON = { top: 400, left: 300, width: 12, height: 12 }

describe('tooltipPosition', () => {
  it('sits under the trigger and centres on it for side bottom', () => {
    const p = tooltipPosition(ICON, BUBBLE, VIEW, 'bottom')
    expect(p.side).toBe('bottom')
    expect(p.top).toBe(418)
    expect(p.left).toBe(196)
    expect(p.arrowLeft).toBe(110)
  })

  it('sits above the trigger for side top', () => {
    const p = tooltipPosition(ICON, BUBBLE, VIEW, 'top')
    expect(p.side).toBe('top')
    expect(p.top).toBe(334)
  })

  it('flips up when the bottom edge is too close, which is ElBiggus case', () => {
    const nearBottom = { ...ICON, top: 770 }
    const p = tooltipPosition(nearBottom, BUBBLE, VIEW, 'bottom')
    expect(p.side).toBe('top')
    expect(p.top).toBe(704)
    expect(p.top).toBeGreaterThanOrEqual(0)
  })

  it('does not flip into an edge that is just as tight', () => {
    // Short window, no room on either side: keep the asked-for side rather
    // than bouncing the bubble to the other cramped edge.
    const p = tooltipPosition({ ...ICON, top: 40 }, BUBBLE, { width: 1280, height: 100 }, 'bottom')
    expect(p.side).toBe('bottom')
  })

  it('pulls the bubble back inside the right edge and keeps the arrow on the trigger', () => {
    const nearRight = { ...ICON, left: 1270 }
    const p = tooltipPosition(nearRight, BUBBLE, VIEW, 'bottom')
    expect(p.left).toBe(1052)
    expect(p.left + BUBBLE.width).toBeLessThanOrEqual(VIEW.width)
    expect(p.arrowLeft).toBe(210)
  })

  it('pulls the bubble back inside the left edge', () => {
    const nearLeft = { ...ICON, left: 2 }
    const p = tooltipPosition(nearLeft, BUBBLE, VIEW, 'bottom')
    expect(p.left).toBe(8)
    expect(p.arrowLeft).toBe(10)
  })

  it('keeps the left margin when the bubble is wider than the window', () => {
    const p = tooltipPosition(ICON, { width: 400, height: 60 }, { width: 320, height: 800 }, 'bottom')
    expect(p.left).toBe(8)
  })

  it('never puts the arrow outside the bubble', () => {
    for (const left of [0, 100, 640, 1279]) {
      const p = tooltipPosition({ ...ICON, left }, BUBBLE, VIEW, 'bottom')
      expect(p.arrowLeft).toBeGreaterThanOrEqual(10)
      expect(p.arrowLeft).toBeLessThanOrEqual(BUBBLE.width - 10)
    }
  })
})
