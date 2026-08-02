import { describe, expect, it } from 'vitest'
import { toMonacoRange } from './reveal'

const maxColumn = (line: number) => 10 + line

describe('toMonacoRange', () => {
  it('converts a line reveal to a collapsed range at that line', () => {
    const range = toMonacoRange({ line: 3 }, 100, maxColumn)
    expect(range).toEqual({
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 1,
    })
  })

  it('honours an explicit column', () => {
    const range = toMonacoRange({ line: 3, column: 5 }, 100, maxColumn)
    expect(range.startColumn).toBe(5)
    expect(range.endColumn).toBe(5)
  })

  it('passes a full range through', () => {
    const range = toMonacoRange(
      { startLine: 2, startColumn: 3, endLine: 4, endColumn: 7 },
      100,
      maxColumn,
    )
    expect(range).toEqual({
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 4,
      endColumn: 7,
    })
  })

  it('clamps a line past the end of the document', () => {
    const range = toMonacoRange({ line: 500 }, 10, maxColumn)
    expect(range.startLineNumber).toBe(10)
  })

  it('clamps a column past the end of its line', () => {
    // maxColumn(2) === 12
    const range = toMonacoRange({ line: 2, column: 999 }, 10, maxColumn)
    expect(range.startColumn).toBe(12)
  })

  it('clamps a non-positive line to the first line', () => {
    const range = toMonacoRange({ line: 0 }, 10, maxColumn)
    expect(range.startLineNumber).toBe(1)
  })
})
