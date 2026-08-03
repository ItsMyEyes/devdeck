import { tabPillTargetWidth } from './browserTabWidth'

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

check('a short inactive label without a favicon hits MIN_WIDTH', () => {
  assertEqual(tabPillTargetWidth({ labelLength: 2, hasFavicon: false, isActive: false }), 72, 'clamped to MIN_WIDTH')
})

check('label length beyond 28 chars is clamped before the width math', () => {
  const at28 = tabPillTargetWidth({ labelLength: 28, hasFavicon: false, isActive: false })
  const at200 = tabPillTargetWidth({ labelLength: 200, hasFavicon: false, isActive: false })
  assertEqual(at200, at28, '28-char clamp')
})

check('a favicon adds its reserved width', () => {
  const without = tabPillTargetWidth({ labelLength: 12, hasFavicon: false, isActive: false })
  const with_ = tabPillTargetWidth({ labelLength: 12, hasFavicon: true, isActive: false })
  assertEqual(with_ - without, 22, 'FAVICON_W (16) + FAVICON_GAP (6)')
})

check('an active pill reserves extra close-slot width over an inactive one', () => {
  const inactive = tabPillTargetWidth({ labelLength: 12, hasFavicon: false, isActive: false })
  const active = tabPillTargetWidth({ labelLength: 12, hasFavicon: false, isActive: true })
  assertEqual(active - inactive, 26, 'CLOSE_W (20) + 6 extra reserved for the active pill')
})

check('width is clamped at MAX_WIDTH for a very long active label with a favicon', () => {
  assertEqual(tabPillTargetWidth({ labelLength: 28, hasFavicon: true, isActive: true }), 220, 'clamped to MAX_WIDTH')
})

console.log(`\n${passed} tests passed`)
