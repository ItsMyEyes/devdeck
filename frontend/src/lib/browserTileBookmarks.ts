// One-shot migration off the machine-proxied workspace Browser tile's old
// localStorage bookmark store. Bookmarks now live server-side (see
// backend/internal/domain.Bookmark) so the same list shows up whether the
// operator is on the desktop app or a phone hitting the same hub — a
// per-device localStorage list can't do that. See
// docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md.

const STORAGE_KEY = 'devdeck.workspaceBrowser.bookmarks'
const HTTP_SCHEME = /^https?:\/\//i

interface LegacyBookmark {
  title: string
  url: string
  group: string
}

function isLegacyBookmark(item: unknown): item is LegacyBookmark {
  const b = item as Partial<LegacyBookmark> | null
  return !!b && typeof b.title === 'string' && typeof b.url === 'string' && typeof b.group === 'string' && HTTP_SCHEME.test(b.url)
}

function loadLegacyBookmarks(): LegacyBookmark[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    // Rebuilt as a clean object (not the filtered raw item) so a legacy
    // record's leftover `id` field never leaks into the new server-side shape.
    return parsed.filter(isLegacyBookmark).map((b) => ({ title: b.title, url: b.url, group: b.group }))
  } catch {
    return []
  }
}

/** Reads and clears any pre-server bookmarks left in localStorage from before
 *  this feature moved server-side, or `[]` if there's nothing to migrate.
 *  Clears immediately (not after the caller's import succeeds) since this
 *  runs once per browser profile — see BrowserTile's mount effect, the only
 *  caller — and a failed one-time import of a handful of old bookmarks is a
 *  cheap loss next to leaking the legacy key forever. */
export function takeLegacyBrowserTileBookmarks(): LegacyBookmark[] {
  const legacy = loadLegacyBookmarks()
  if (legacy.length > 0 && typeof window !== 'undefined') {
    window.localStorage.removeItem(STORAGE_KEY)
  }
  return legacy
}
