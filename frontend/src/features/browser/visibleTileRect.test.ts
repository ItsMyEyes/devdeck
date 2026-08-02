import { describe, expect, it } from 'vitest'
import { MIN_VISIBLE_AREA_FRACTION, visibleTileRect } from './visibleTileRect'

// A wide tile under a typical toolbar, matching the desktop layout the bug was
// reported against.
const tile = { left: 100, top: 100, right: 1000, bottom: 800 }

describe('visibleTileRect', () => {
  it('returns the whole tile when nothing blocks it', () => {
    expect(visibleTileRect(tile, {}, false)).toEqual(tile)
  })

  it('returns the whole tile for a blocker that does not intersect', () => {
    expect(visibleTileRect(tile, { a: { left: 1200, top: 100, right: 1400, bottom: 300 } }, false)).toEqual(tile)
  })

  it('hides for a viewport-scoped blocker regardless of geometry', () => {
    expect(visibleTileRect(tile, { a: 'viewport' }, false)).toBeNull()
  })

  it('hides while a tile drag is active, before any rect math', () => {
    expect(visibleTileRect(tile, {}, true)).toBeNull()
  })

  // The reported bug: a ~300px machine dropdown overlapping the top-right
  // corner blanked the entire page. The largest remainder is everything below
  // it, so the page stays visible and merely loses that strip.
  it('shrinks below a dropdown overlapping the top-right corner instead of hiding', () => {
    const dropdown = { left: 700, top: 60, right: 1000, bottom: 220 }
    expect(visibleTileRect(tile, { a: dropdown }, false)).toEqual({
      left: 100,
      top: 220,
      right: 1000,
      bottom: 800,
    })
  })

  it('shrinks sideways when the side remainder is the larger one', () => {
    // Full-height overlay pinned to the right edge: cutting horizontally leaves
    // nothing, cutting vertically leaves most of the tile.
    const panel = { left: 800, top: 100, right: 1000, bottom: 800 }
    expect(visibleTileRect(tile, { a: panel }, false)).toEqual({
      left: 100,
      top: 100,
      right: 800,
      bottom: 800,
    })
  })

  it('hides when a centred overlay leaves no remainder worth showing', () => {
    // Every remainder is ~33% of the tile, under the keep threshold — a sliver
    // of page is more confusing than an honest blank.
    const dialog = { left: 400, top: 300, right: 700, bottom: 600 }
    expect(visibleTileRect(tile, { a: dialog }, false)).toBeNull()
  })

  it('hides when a blocker covers the tile completely', () => {
    expect(visibleTileRect(tile, { a: { left: 0, top: 0, right: 2000, bottom: 2000 } }, false)).toBeNull()
  })

  it('carves multiple intersecting blockers and hides once too little is left', () => {
    const topStrip = { left: 100, top: 100, right: 1000, bottom: 500 }
    const bottomStrip = { left: 100, top: 640, right: 1000, bottom: 800 }
    // 500..640 survives both cuts: 900x140 = 126000 of 630000 = 20%.
    expect(visibleTileRect(tile, { a: topStrip, b: bottomStrip }, false)).toBeNull()
  })

  it('keeps a remainder that clears the threshold after two cuts', () => {
    const thinTop = { left: 100, top: 100, right: 1000, bottom: 180 }
    const thinBottom = { left: 100, top: 760, right: 1000, bottom: 800 }
    expect(visibleTileRect(tile, { a: thinTop, b: thinBottom }, false)).toEqual({
      left: 100,
      top: 180,
      right: 1000,
      bottom: 760,
    })
  })

  it('treats a degenerate zero-area tile as hidden rather than dividing by zero', () => {
    expect(visibleTileRect({ left: 0, top: 0, right: 0, bottom: 0 }, {}, false)).toBeNull()
  })

  it('exposes the keep threshold it applies', () => {
    expect(MIN_VISIBLE_AREA_FRACTION).toBeGreaterThan(0)
    expect(MIN_VISIBLE_AREA_FRACTION).toBeLessThan(1)
  })
})
