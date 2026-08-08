/**
 * Plain assertion-based tests, matching ripgrepInstallPrefs.test.ts's
 * convention (no Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/lib/browserTileBookmarks.test.ts
 *
 * Covers takeLegacyBrowserTileBookmarks: it must read pre-server bookmarks
 * exactly once and clear the legacy key immediately, since BrowserTile's
 * mount effect calls it unconditionally on every mount (a regression here
 * would either re-import the same bookmarks on every tab open, or silently
 * drop them without ever migrating).
 */

class FakeLocalStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
}

const fakeStorage = new FakeLocalStorage()
;(globalThis as unknown as { window: { localStorage: FakeLocalStorage } }).window = { localStorage: fakeStorage }

import { takeLegacyBrowserTileBookmarks } from './browserTileBookmarks'

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

const STORAGE_KEY = 'devdeck.workspaceBrowser.bookmarks'

check('returns [] when nothing was ever saved', () => {
  assertEqual(takeLegacyBrowserTileBookmarks(), [], 'no legacy key')
})

check('returns saved legacy bookmarks and filters malformed entries', () => {
  fakeStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      { id: 'x', title: 'Example', url: 'https://example.com/', group: 'Docs' },
      { id: 'y', title: 'No URL' }, // malformed: missing url — must be dropped
      { id: 'z', title: 'Bad scheme', url: 'javascript:alert(1)', group: '' }, // non-http(s) — must be dropped
    ]),
  )
  const legacy = takeLegacyBrowserTileBookmarks()
  assertEqual(legacy, [{ title: 'Example', url: 'https://example.com/', group: 'Docs' }], 'valid entries survive, malformed ones filtered')
})

check('clears the legacy key so a second call returns []', () => {
  fakeStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([{ id: 'x', title: 'Example', url: 'https://example.com/', group: 'Docs' }]),
  )
  const first = takeLegacyBrowserTileBookmarks()
  assertEqual(first.length, 1, 'first call sees the saved bookmark')
  const second = takeLegacyBrowserTileBookmarks()
  assertEqual(second, [], 'second call sees nothing - already migrated and cleared')
})

check('malformed JSON in the legacy key is treated as no bookmarks, not a crash', () => {
  fakeStorage.setItem(STORAGE_KEY, '{not json')
  assertEqual(takeLegacyBrowserTileBookmarks(), [], 'malformed JSON yields empty list')
})

console.log(`\n${passed} tests passed`)
