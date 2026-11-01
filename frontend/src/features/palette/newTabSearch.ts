import { looksLikeUrl, normalizeUrl } from '@/features/palette/providers/bookmarks'

export function resolveNewTabSearch(query: string): { kind: 'terminal' } | { kind: 'url'; url: string } | null {
  const text = query.trim()
  if (!text) return null
  if (text.toLowerCase() === 'terminal') return { kind: 'terminal' }
  if (looksLikeUrl(text)) return { kind: 'url', url: normalizeUrl(text) }
  return { kind: 'url', url: `https://www.google.com/search?${new URLSearchParams({ q: text })}` }
}
