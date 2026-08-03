import { DEFAULT_ZOOM, zoomStep, ZOOM_LEVELS } from './browserZoom'

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

check('zooming in from the default level moves to the next level up', () => {
  assertEqual(zoomStep(DEFAULT_ZOOM, 1), 1.1, 'one step up from 100%')
})

check('zooming out from the default level moves to the next level down', () => {
  assertEqual(zoomStep(DEFAULT_ZOOM, -1), 0.9, 'one step down from 100%')
})

check('zooming in clamps at the top of ZOOM_LEVELS', () => {
  assertEqual(zoomStep(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], 1), ZOOM_LEVELS[ZOOM_LEVELS.length - 1], 'clamped at max')
})

check('zooming out clamps at the bottom of ZOOM_LEVELS', () => {
  assertEqual(zoomStep(ZOOM_LEVELS[0], -1), ZOOM_LEVELS[0], 'clamped at min')
})

check('stepping from a level not exactly on the table snaps to the nearest one first', () => {
  assertEqual(zoomStep(1.05, 1), 1.25, 'nearest-then-step from an off-table value')
})

console.log(`\n${passed} tests passed`)
