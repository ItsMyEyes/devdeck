import { rectsIntersect, tileShouldBeHidden } from './browserTileOcclusion'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}
function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
}

const tileRect = { left: 100, top: 100, right: 300, bottom: 300 }

check('rectsIntersect is true for overlapping rects', () => {
  assertEqual(rectsIntersect(tileRect, { left: 200, top: 200, right: 400, bottom: 400 }), true, 'overlapping')
})

check('rectsIntersect is false for disjoint rects', () => {
  assertEqual(rectsIntersect(tileRect, { left: 400, top: 400, right: 500, bottom: 500 }), false, 'disjoint')
})

check('rectsIntersect is false for merely-touching (edge-adjacent) rects', () => {
  assertEqual(rectsIntersect(tileRect, { left: 300, top: 100, right: 400, bottom: 300 }), false, 'edge-adjacent, not overlapping')
})

check('tileShouldBeHidden is false with no blockers and no drag', () => {
  assertEqual(tileShouldBeHidden(tileRect, {}, false), false, 'nothing blocking')
})

check("tileShouldBeHidden is true for a 'viewport' blocker regardless of rect", () => {
  assertEqual(tileShouldBeHidden(tileRect, { a: 'viewport' }, false), true, "'viewport' always hides")
})

check('tileShouldBeHidden is false for a blocker rect that does not intersect the tile', () => {
  assertEqual(tileShouldBeHidden(tileRect, { a: { left: 400, top: 400, right: 500, bottom: 500 } }, false), false, 'non-intersecting rect never hides')
})

check('tileShouldBeHidden is true for a blocker rect that intersects the tile', () => {
  assertEqual(tileShouldBeHidden(tileRect, { a: { left: 200, top: 200, right: 400, bottom: 400 } }, false), true, 'intersecting rect hides')
})

check('tileShouldBeHidden short-circuits on tileDragActive before any rect math', () => {
  assertEqual(tileShouldBeHidden(tileRect, {}, true), true, 'tileDragActive hides even with zero blockers')
})

console.log(`\n${passed} tests passed`)
