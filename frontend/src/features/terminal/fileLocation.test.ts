import { describe, expect, it } from 'vitest'
import { formatFileLocation, parseFileQuery } from './fileLocation'

describe('parseFileQuery', () => {
  it('splits a line and column off the path', () => {
    expect(parseFileQuery('src/App.tsx:123:23')).toEqual({
      query: 'src/App.tsx',
      location: { line: 123, column: 23 },
    })
  })

  it('accepts a line on its own', () => {
    expect(parseFileQuery('main.go:42')).toEqual({ query: 'main.go', location: { line: 42 } })
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(parseFileQuery('  main.go:42:7  ')).toEqual({
      query: 'main.go',
      location: { line: 42, column: 7 },
    })
  })

  it('leaves a plain path alone', () => {
    expect(parseFileQuery('src/App.tsx')).toEqual({ query: 'src/App.tsx' })
  })

  // Mid-typing states: the suffix is incomplete, so the search must keep
  // running against the whole path rather than blanking out for a keystroke.
  it('ignores a dangling colon', () => {
    expect(parseFileQuery('src/App.tsx:')).toEqual({ query: 'src/App.tsx:' })
  })

  it('ignores a dangling colon after the line', () => {
    expect(parseFileQuery('src/App.tsx:123:')).toEqual({ query: 'src/App.tsx:123:' })
  })

  it('treats a bare :42 as a literal search', () => {
    expect(parseFileQuery(':42')).toEqual({ query: ':42' })
  })

  it('rejects a zero line', () => {
    expect(parseFileQuery('main.go:0')).toEqual({ query: 'main.go:0' })
  })

  it('drops a zero column but keeps the line', () => {
    expect(parseFileQuery('main.go:12:0')).toEqual({ query: 'main.go', location: { line: 12 } })
  })

  it('rejects a line past the safe integer range', () => {
    expect(parseFileQuery('main.go:99999999999999999999')).toEqual({
      query: 'main.go:99999999999999999999',
    })
  })

  it('keeps a path that only looks like it has a suffix', () => {
    expect(parseFileQuery('docker-compose:v2.yml')).toEqual({ query: 'docker-compose:v2.yml' })
  })

  it('parses a suffix on an absolute path', () => {
    expect(parseFileQuery('/root/app/main.go:9:1')).toEqual({
      query: '/root/app/main.go',
      location: { line: 9, column: 1 },
    })
  })

  it('returns the empty query for empty input', () => {
    expect(parseFileQuery('   ')).toEqual({ query: '' })
  })
})

describe('formatFileLocation', () => {
  it('renders a line-only location', () => {
    expect(formatFileLocation({ line: 42 })).toBe(':42')
  })

  it('renders a line and column', () => {
    expect(formatFileLocation({ line: 42, column: 7 })).toBe(':42:7')
  })
})
