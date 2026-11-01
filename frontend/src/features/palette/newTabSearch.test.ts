import { describe, expect, it } from 'vitest'
import { resolveNewTabSearch } from '@/features/palette/newTabSearch'

describe('new tab search', () => {
  it('opens a local terminal for terminal, regardless of casing or surrounding whitespace', () => {
    expect(resolveNewTabSearch('  Terminal  ')).toEqual({ kind: 'terminal' })
  })
  it('searches arbitrary text with Google', () => {
    expect(resolveNewTabSearch('zsh config & aliases')).toEqual({
      kind: 'url', url: 'https://www.google.com/search?q=zsh+config+%26+aliases',
    })
  })
  it('opens a typed URL directly', () => {
    expect(resolveNewTabSearch('example.com')).toEqual({ kind: 'url', url: 'https://example.com' })
  })
  it('does nothing for empty input', () => {
    expect(resolveNewTabSearch('  ')).toBeNull()
  })
})
