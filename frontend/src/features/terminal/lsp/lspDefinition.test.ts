import { describe, expect, it } from 'vitest'
import { crossFileTargets, normalizeDefinitionResult } from './lspDefinition'

const range = { start: { line: 4, character: 5 }, end: { line: 4, character: 19 } }
const selection = { start: { line: 4, character: 5 }, end: { line: 4, character: 12 } }

describe('normalizeDefinitionResult', () => {
  it('accepts a single Location', () => {
    expect(normalizeDefinitionResult({ uri: 'file:///root/a.go', range })).toEqual([
      { uri: 'file:///root/a.go', range },
    ])
  })

  it('accepts an array of Locations', () => {
    const result = normalizeDefinitionResult([
      { uri: 'file:///root/a.go', range },
      { uri: 'file:///root/b.go', range },
    ])
    expect(result.map((t) => t.uri)).toEqual(['file:///root/a.go', 'file:///root/b.go'])
  })

  it('accepts LocationLinks and prefers targetSelectionRange over targetRange', () => {
    const result = normalizeDefinitionResult([
      { targetUri: 'file:///root/a.go', targetRange: range, targetSelectionRange: selection },
    ])
    // targetRange spans the whole declaration; targetSelectionRange is the
    // identifier, which is where the cursor should land.
    expect(result).toEqual([{ uri: 'file:///root/a.go', range: selection }])
  })

  it('falls back to targetRange when a LocationLink has no selection range', () => {
    const result = normalizeDefinitionResult([{ targetUri: 'file:///root/a.go', targetRange: range }])
    expect(result).toEqual([{ uri: 'file:///root/a.go', range }])
  })

  it('returns nothing for null, undefined or an empty array', () => {
    expect(normalizeDefinitionResult(null)).toEqual([])
    expect(normalizeDefinitionResult(undefined)).toEqual([])
    expect(normalizeDefinitionResult([])).toEqual([])
  })

  it('skips malformed entries rather than throwing', () => {
    const result = normalizeDefinitionResult([
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

describe('crossFileTargets', () => {
  it('drops targets in the current file, which the built-in provider already serves', () => {
    const targets = [
      { uri: 'file:///root/a.go', range },
      { uri: 'file:///root/b.go', range },
    ]
    expect(crossFileTargets(targets, 'file:///root/a.go')).toEqual([
      { uri: 'file:///root/b.go', range },
    ])
  })

  it('compares uris case-insensitively, matching translateBackRange', () => {
    const targets = [{ uri: 'file:///Root/A.go', range }]
    expect(crossFileTargets(targets, 'file:///root/a.go')).toEqual([])
  })

  it('keeps everything when nothing is in the current file', () => {
    const targets = [{ uri: 'file:///root/b.go', range }]
    expect(crossFileTargets(targets, 'file:///root/a.go')).toHaveLength(1)
  })
})
