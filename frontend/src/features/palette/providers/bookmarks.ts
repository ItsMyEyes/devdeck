import { Globe, Star } from 'lucide-react'
import type { PaletteItem } from '@/features/palette/paletteTypes'

/** host[:port][/path] with at least one dot, or an explicit scheme, or
 *  localhost with a port. Deliberately strict: `feat/palette` and
 *  `ssh root@host` must NOT be mistaken for URLs. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const HOSTLIKE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i
const LOCALHOST = /^localhost(?::\d+)?(?:\/\S*)?$/i
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\S*)?$/

export function looksLikeUrl(query: string): boolean {
  const trimmed = query.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  return SCHEME.test(trimmed) || HOSTLIKE.test(trimmed) || LOCALHOST.test(trimmed) || IPV4.test(trimmed)
}

/** Local targets get `http://` — a dev server on localhost or a LAN IP
 *  almost never speaks TLS, and an https guess would just fail. */
export function normalizeUrl(query: string): string {
  const trimmed = query.trim()
  if (SCHEME.test(trimmed)) return trimmed
  const scheme = LOCALHOST.test(trimmed) || IPV4.test(trimmed) ? 'http' : 'https'
  return `${scheme}://${trimmed}`
}

export function bookmarkItems(
  bookmarks: { id: string; title: string; url: string }[],
  query: string,
  openUrl: (url: string) => void,
): PaletteItem[] {
  const items: PaletteItem[] = bookmarks.map((bookmark) => ({
    id: `bookmark:${bookmark.id}`,
    kind: 'bookmark',
    group: 'results',
    title: bookmark.title,
    subtitle: bookmark.url,
    keywords: [bookmark.url],
    icon: Star,
    run: () => openUrl(bookmark.url),
  }))

  if (looksLikeUrl(query)) {
    const url = normalizeUrl(query)
    items.push({
      id: `url:${url}`,
      kind: 'url',
      group: 'results',
      title: url,
      subtitle: 'open in a Browser tile',
      icon: Globe,
      run: () => openUrl(url),
    })
  }

  return items
}
