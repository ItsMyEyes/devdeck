import { describe, expect, it, vi } from 'vitest'
import { bookmarkItems, looksLikeUrl, normalizeUrl } from '@/features/palette/providers/bookmarks'

describe('looksLikeUrl', () => {
  it.each(['github.com', 'https://github.com/acme/api', 'localhost:3000', '10.1.1.4:8080', 'sub.domain.co.uk/path'])(
    'accepts %s',
    (input) => expect(looksLikeUrl(input)).toBe(true),
  )

  it.each(['prod', 'feat/palette', 'ssh root@host', 'agent-new acme', '', '   '])(
    'rejects %s',
    (input) => expect(looksLikeUrl(input)).toBe(false),
  )
})

describe('normalizeUrl', () => {
  it('leaves an explicit scheme alone', () => {
    expect(normalizeUrl('https://github.com')).toBe('https://github.com')
  })

  it('prefixes a bare host with https', () => {
    expect(normalizeUrl('github.com')).toBe('https://github.com')
  })

  it('prefixes localhost with http, not https', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000')
  })

  it('prefixes a bare IPv4 with http', () => {
    expect(normalizeUrl('10.1.1.4:8080')).toBe('http://10.1.1.4:8080')
  })
})

describe('bookmarkItems', () => {
  const bookmarks = [{ id: 'b1', title: 'API repo', url: 'https://github.com/acme/api' }]

  it('emits one item per bookmark', () => {
    const items = bookmarkItems(bookmarks, '', () => {})
    expect(items.filter((i) => i.kind === 'bookmark')).toHaveLength(1)
  })

  it('exposes the url as a keyword so typing the domain finds the bookmark', () => {
    const items = bookmarkItems(bookmarks, '', () => {})
    expect(items[0].keywords).toContain('https://github.com/acme/api')
  })

  it('appends an open-url item when the query looks like a url', () => {
    const items = bookmarkItems(bookmarks, 'example.com', () => {})
    const url = items.find((i) => i.kind === 'url')
    expect(url?.title).toBe('https://example.com')
  })

  it('does not append an open-url item for a plain word', () => {
    expect(bookmarkItems(bookmarks, 'prod', () => {}).some((i) => i.kind === 'url')).toBe(false)
  })

  it('opens the normalized url when run', () => {
    const openUrl = vi.fn()
    const items = bookmarkItems([], 'github.com', openUrl)
    items[0].run?.({ wsId: 'ws1', leafId: 'l', showToast: () => {}, close: () => {} })
    expect(openUrl).toHaveBeenCalledWith('https://github.com')
  })
})
