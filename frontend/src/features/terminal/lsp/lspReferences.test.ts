import { describe, expect, it } from 'vitest'
import { normalizeReferenceResult, toMonacoRange } from './lspReferences'

const range = { start: { line: 4, character: 5 }, end: { line: 4, character: 19 } }

describe('normalizeReferenceResult', () => {
  it('accepts an array of Locations', () => {
    const result = normalizeReferenceResult([
      { uri: 'file:///root/a.go', range },
      { uri: 'file:///root/b.go', range },
    ])
    expect(result).toEqual([
      { uri: 'file:///root/a.go', range },
      { uri: 'file:///root/b.go', range },
    ])
  })

  it('keeps references that live in the file the request came from', () => {
    // The definition provider drops same-file targets because monaco's built-in
    // provider already serves them (see crossFileTargets). References must not:
    // one cross-file result is enough to make the built-in provider throw for
    // the *whole* batch, so this provider is the only source for the same-file
    // ones too. Dropping them would hide every local call site.
    const result = normalizeReferenceResult([
      { uri: 'file:///root/a.go', range },
      { uri: 'file:///root/b.go', range },
    ])
    expect(result.map((target) => target.uri)).toContain('file:///root/a.go')
  })

  it('accepts a single Location', () => {
    expect(normalizeReferenceResult({ uri: 'file:///root/a.go', range })).toEqual([
      { uri: 'file:///root/a.go', range },
    ])
  })

  it('returns nothing for null, undefined or an empty array', () => {
    expect(normalizeReferenceResult(null)).toEqual([])
    expect(normalizeReferenceResult(undefined)).toEqual([])
    expect(normalizeReferenceResult([])).toEqual([])
  })

  it('skips malformed entries rather than throwing', () => {
    const result = normalizeReferenceResult([
      null,
      'nonsense',
      { uri: 'file:///root/a.go' },
      { range },
      { uri: 'file:///root/b.go', range: { start: { line: 1 } } },
      { uri: 'file:///root/c.go', range },
    ])
    expect(result).toEqual([{ uri: 'file:///root/c.go', range }])
  })
})

describe('toMonacoRange', () => {
  it('converts LSP 0-based positions to monaco 1-based ones', () => {
    expect(toMonacoRange(range)).toEqual({
      startLineNumber: 5,
      startColumn: 6,
      endLineNumber: 5,
      endColumn: 20,
    })
  })

  it('maps the very first character of a file to line 1, column 1', () => {
    expect(
      toMonacoRange({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }),
    ).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 })
  })
})
