// Standalone bookmark store for the machine-proxied workspace Browser tile.
// Deliberately separate from the sandboxed-iframe BrowserModule's own
// `devdeck.browser.bookmarks` — starring a page in one surface does not appear
// in the other. See
// docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md.

export interface BrowserTileBookmark {
  id: string
  title: string
  url: string
  group: string
}

const STORAGE_KEY = 'devdeck.workspaceBrowser.bookmarks'
const HTTP_SCHEME = /^https?:\/\//i

function newBookmarkId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function persist(bookmarks: BrowserTileBookmark[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks))
  } catch {
    // Bookmark persistence is a convenience; browsing itself still works.
  }
}

export function loadBrowserTileBookmarks(): BrowserTileBookmark[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is BrowserTileBookmark =>
        !!item &&
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        typeof item.url === 'string' &&
        typeof item.group === 'string' &&
        HTTP_SCHEME.test(item.url),
    )
  } catch {
    return []
  }
}

export function addBrowserTileBookmark(
  bookmarks: BrowserTileBookmark[],
  entry: { title: string; url: string; group: string },
): BrowserTileBookmark[] {
  const group = entry.group.trim() || 'Portal'
  const existing = bookmarks.find((b) => b.url === entry.url && b.group.toLowerCase() === group.toLowerCase())
  const next = existing
    ? bookmarks.map((b) => (b.id === existing.id ? { ...b, title: entry.title, group } : b))
    : [...bookmarks, { id: newBookmarkId(), title: entry.title, url: entry.url, group }]
  persist(next)
  return next
}

export function removeBrowserTileBookmark(bookmarks: BrowserTileBookmark[], bookmarkId: string): BrowserTileBookmark[] {
  const next = bookmarks.filter((b) => b.id !== bookmarkId)
  persist(next)
  return next
}

export function groupBrowserTileBookmarks(bookmarks: BrowserTileBookmark[]): [string, BrowserTileBookmark[]][] {
  const groups = new Map<string, BrowserTileBookmark[]>()
  for (const bookmark of bookmarks) {
    const group = bookmark.group.trim() || 'Portal'
    groups.set(group, [...(groups.get(group) ?? []), bookmark])
  }
  return [...groups.entries()]
}
