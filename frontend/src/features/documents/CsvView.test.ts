import { describe, expect, it } from 'vitest'
import { buildGrid } from './CsvView'
import { MAX_COLUMNS, MAX_ROWS } from './sheet'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('buildGrid', () => {
  it('reads the first record as the header and the rest as rows', () => {
    const grid = buildGrid(bytes('name,size\nalpha,10\nbeta,20\n'))
    expect(grid.headers).toEqual(['name', 'size'])
    expect(grid.rows).toEqual([
      ['alpha', '10'],
      ['beta', '20'],
    ])
    expect(grid.columnCount).toBe(2)
    expect(grid.truncated).toBe(false)
  })

  it('honours RFC 4180 quoting rather than splitting on every comma', () => {
    const grid = buildGrid(bytes('a,b\n"one,two",three\n'))
    expect(grid.rows).toEqual([['one,two', 'three']])
  })

  it('detects a tab-delimited file without being told', () => {
    const grid = buildGrid(bytes('name\tsize\nalpha\t10\n'))
    expect(grid.headers).toEqual(['name', 'size'])
    expect(grid.rows).toEqual([['alpha', '10']])
  })

  it('pads ragged rows to a rectangle so the grid lines do not break up', () => {
    const grid = buildGrid(bytes('a,b,c\n1\n2,3\n'))
    expect(grid.columnCount).toBe(3)
    expect(grid.rows).toEqual([
      ['1', '', ''],
      ['2', '3', ''],
    ])
  })

  it('widens to the longest row, not just the header', () => {
    const grid = buildGrid(bytes('a,b\n1,2,3,4\n'))
    expect(grid.columnCount).toBe(4)
    expect(grid.rows[0]).toEqual(['1', '2', '3', '4'])
  })

  it('caps rows and says so, instead of handing React a million <tr>s', () => {
    const lines = ['h']
    for (let i = 0; i < MAX_ROWS + 25; i += 1) lines.push(String(i))
    const grid = buildGrid(bytes(lines.join('\n')))
    expect(grid.rows).toHaveLength(MAX_ROWS)
    expect(grid.totalRows).toBe(MAX_ROWS + 25)
    expect(grid.truncated).toBe(true)
  })

  it('caps columns the same way', () => {
    const wide = Array.from({ length: MAX_COLUMNS + 10 }, (_, i) => `c${i}`).join(',')
    const grid = buildGrid(bytes(`${wide}\n${wide}\n`))
    expect(grid.columnCount).toBe(MAX_COLUMNS)
    expect(grid.headers).toHaveLength(MAX_COLUMNS)
    expect(grid.rows[0]).toHaveLength(MAX_COLUMNS)
    expect(grid.truncated).toBe(true)
  })

  it('reports non-UTF-8 bytes rather than rendering replacement characters', () => {
    // 0xFF is not a legal UTF-8 lead byte.
    const grid = buildGrid(new Uint8Array([0x61, 0x2c, 0x62, 0x0a, 0xff, 0xfe]))
    expect(grid.error).toMatch(/not valid UTF-8/)
    expect(grid.rows).toEqual([])
  })

  it('treats an empty or whitespace-only file as empty, not as an error', () => {
    expect(buildGrid(bytes('')).rows).toEqual([])
    expect(buildGrid(bytes('   \n\n')).error).toBeUndefined()
    expect(buildGrid(bytes('   \n\n')).rows).toEqual([])
  })

  it('handles a header-only file: columns, no rows', () => {
    const grid = buildGrid(bytes('name,size\n'))
    expect(grid.headers).toEqual(['name', 'size'])
    expect(grid.rows).toEqual([])
    expect(grid.truncated).toBe(false)
  })
})
