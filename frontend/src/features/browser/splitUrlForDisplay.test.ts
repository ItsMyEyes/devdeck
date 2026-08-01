import { describe, expect, it } from 'vitest'
import { splitUrlForDisplay } from '@/features/browser/splitUrlForDisplay'

describe('splitUrlForDisplay', () => {
  it('splits a www subdomain off the registrable domain', () => {
    expect(splitUrlForDisplay('https://www.youtube.com/')).toEqual({
      prefix: 'www.',
      domain: 'youtube.com',
      rest: '',
    })
  })

  it('treats a bare two-label host as all domain', () => {
    expect(splitUrlForDisplay('https://example.com/')).toEqual({
      prefix: '',
      domain: 'example.com',
      rest: '',
    })
  })

  it('keeps path, query and hash in rest', () => {
    expect(splitUrlForDisplay('https://docs.example.com/a/b?q=1#top')).toEqual({
      prefix: 'docs.',
      domain: 'example.com',
      rest: '/a/b?q=1#top',
    })
  })

  it('strips a trailing slash from a non-root path', () => {
    expect(splitUrlForDisplay('http://example.com/dashboard/')).toEqual({
      prefix: '',
      domain: 'example.com',
      rest: '/dashboard',
    })
  })

  it('keeps a multi-part public suffix intact', () => {
    expect(splitUrlForDisplay('https://shop.google.co.uk/cart')).toEqual({
      prefix: 'shop.',
      domain: 'google.co.uk',
      rest: '/cart',
    })
  })

  it('keeps the port on the domain for localhost', () => {
    expect(splitUrlForDisplay('http://localhost:5173/w/1')).toEqual({
      prefix: '',
      domain: 'localhost:5173',
      rest: '/w/1',
    })
  })

  it('treats an IPv4 literal as a single domain', () => {
    expect(splitUrlForDisplay('http://192.168.1.10:8080/status')).toEqual({
      prefix: '',
      domain: '192.168.1.10:8080',
      rest: '/status',
    })
  })

  it('returns non-URL search text whole, at full contrast', () => {
    expect(splitUrlForDisplay('how to center a div')).toEqual({
      prefix: '',
      domain: 'how to center a div',
      rest: '',
    })
  })

  it('reads an empty url as New Tab', () => {
    expect(splitUrlForDisplay('')).toEqual({ prefix: '', domain: 'New Tab', rest: '' })
  })
})
