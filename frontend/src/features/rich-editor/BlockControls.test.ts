import { describe, expect, it } from 'vitest'
import { columnX, scrollStep } from './BlockControls'

/** The text column, as `view.dom.getBoundingClientRect()` reports it. */
const COLUMN = { left: 450, right: 1158 }

describe('columnX', () => {
  it('leaves a pointer already inside the text column alone', () => {
    expect(columnX(510, COLUMN)).toBe(510)
    expect(columnX(1100, COLUMN)).toBe(1100)
  })

  // The regression this exists for: the gutter sits ~52px to the LEFT of the
  // editor, outside its DOM box, so `posAtCoords` used to answer null the
  // moment the pointer crossed `left` on its way to the handle — and the
  // controls unmounted a few pixels short of the button.
  it('pulls a pointer in the gutter back into the column', () => {
    expect(columnX(398, COLUMN)).toBe(451) // over the "+" button
    expect(columnX(448, COLUMN)).toBe(451) // the pixel it used to die on
    expect(columnX(0, COLUMN)).toBe(451)
  })

  it('pulls a pointer past the right edge back in', () => {
    expect(columnX(2000, COLUMN)).toBe(1157)
  })

  it('stays inside the box, never on its boundary', () => {
    // posAtCoords on the exact edge is a coin flip between the editor and
    // whatever is behind it, so the clamp deliberately lands one pixel in.
    expect(columnX(450, COLUMN)).toBeGreaterThan(COLUMN.left)
    expect(columnX(1158, COLUMN)).toBeLessThan(COLUMN.right)
  })
})

/** The document pane, as `getBoundingClientRect()` reports it. */
const PANE = { top: 100, bottom: 800 }

// The regression this exists for: neither Chromium nor WebKit auto-scrolls a
// nested `overflow: auto` container during an HTML5 drag, and the document
// always sits in one. Without a step to drive it by hand, a block could only
// ever be dropped where the pointer could already reach — so in a file longer
// than the pane, moving a block to another section was impossible.
describe('scrollStep', () => {
  it('does not scroll while the pointer is in the middle of the pane', () => {
    expect(scrollStep(450, PANE)).toBe(0)
    expect(scrollStep(165, PANE)).toBe(0) // just inside the top band
    expect(scrollStep(735, PANE)).toBe(0) // just inside the bottom band
  })

  it('pulls the document up as the pointer nears the top edge', () => {
    expect(scrollStep(132, PANE)).toBeLessThan(0)
    // Deeper into the band is faster.
    expect(scrollStep(110, PANE)).toBeLessThan(scrollStep(132, PANE))
  })

  it('pulls the document down as the pointer nears the bottom edge', () => {
    expect(scrollStep(770, PANE)).toBeGreaterThan(0)
    expect(scrollStep(795, PANE)).toBeGreaterThan(scrollStep(770, PANE))
  })

  it('holds full speed once the pointer leaves the pane entirely', () => {
    // Dragging past the edge is the "keep going" gesture — it must not wrap
    // round to zero or reverse as the distance grows.
    expect(scrollStep(100, PANE)).toBe(-18)
    expect(scrollStep(-500, PANE)).toBe(-18)
    expect(scrollStep(800, PANE)).toBe(18)
    expect(scrollStep(5000, PANE)).toBe(18)
  })

  it('scrolls up, not down, in a pane shorter than both edge bands', () => {
    // A pane under 2×SCROLL_ZONE tall has overlapping bands; the top has to
    // win outright rather than the two cancelling into a jitter.
    expect(scrollStep(340, { top: 300, bottom: 380 })).toBeLessThan(0)
  })
})
