import { describe, expect, it } from 'vitest'
import { applyTextEdits, splitWorkspaceEdit } from './lspWorkspaceEdit'

const ROOT = 'file:///work/repo'
const pathFromUri = (uri: string) =>
  uri.startsWith(`${ROOT}/`) ? decodeURIComponent(uri.slice(ROOT.length + 1)) : null

function edit(line: number, from: number, to: number, newText: string) {
  return { range: { start: { line, character: from }, end: { line, character: to } }, newText }
}

describe('splitWorkspaceEdit', () => {
  it('separates the current document from other files in a changes map', () => {
    const result = splitWorkspaceEdit(
      {
        changes: {
          [`${ROOT}/main.go`]: [edit(0, 5, 8, 'Bar')],
          [`${ROOT}/pkg/util.go`]: [edit(2, 1, 4, 'Bar'), edit(9, 0, 3, 'Bar')],
        },
      },
      `${ROOT}/main.go`,
      pathFromUri,
    )

    expect(result.currentEdits).toHaveLength(1)
    expect(result.otherFiles).toEqual([
      { uri: `${ROOT}/pkg/util.go`, path: 'pkg/util.go', edits: [edit(2, 1, 4, 'Bar'), edit(9, 0, 3, 'Bar')] },
    ])
    expect(result.unsupportedOps).toEqual([])
    expect(result.outsideRoot).toEqual([])
  })

  it('reads documentChanges and merges them with changes for the same uri', () => {
    const result = splitWorkspaceEdit(
      {
        changes: { [`${ROOT}/a.go`]: [edit(0, 0, 1, 'X')] },
        documentChanges: [
          { textDocument: { uri: `${ROOT}/a.go`, version: 2 }, edits: [edit(1, 0, 1, 'Y')] },
          { textDocument: { uri: `${ROOT}/b.go`, version: 1 }, edits: [edit(3, 2, 5, 'Z')] },
        ],
      },
      `${ROOT}/main.go`,
      pathFromUri,
    )

    expect(result.currentEdits).toEqual([])
    expect(result.otherFiles.map((file) => file.path)).toEqual(['a.go', 'b.go'])
    expect(result.otherFiles[0]?.edits).toHaveLength(2)
  })

  it('reports file operations instead of applying them', () => {
    const result = splitWorkspaceEdit(
      {
        documentChanges: [
          { kind: 'rename', oldUri: `${ROOT}/a.go`, newUri: `${ROOT}/b.go` },
          { kind: 'delete', uri: `${ROOT}/c.go` },
        ],
      },
      `${ROOT}/main.go`,
      pathFromUri,
    )

    expect(result.unsupportedOps).toEqual(['rename', 'delete'])
    expect(result.otherFiles).toEqual([])
  })

  it('reports uris that fall outside the worktree root', () => {
    const result = splitWorkspaceEdit(
      { changes: { 'file:///usr/local/go/src/fmt/print.go': [edit(0, 0, 1, 'X')] } },
      `${ROOT}/main.go`,
      pathFromUri,
    )

    expect(result.outsideRoot).toEqual(['file:///usr/local/go/src/fmt/print.go'])
    expect(result.otherFiles).toEqual([])
  })

  it('returns an empty split for a null edit', () => {
    const result = splitWorkspaceEdit(null, `${ROOT}/main.go`, pathFromUri)
    expect(result).toEqual({ currentEdits: [], otherFiles: [], unsupportedOps: [], outsideRoot: [] })
  })
})

describe('applyTextEdits', () => {
  it('applies multiple edits on one line without shifting later ranges', () => {
    const text = 'foo(foo, foo)\n'
    const result = applyTextEdits(text, [edit(0, 0, 3, 'bar'), edit(0, 4, 7, 'bar'), edit(0, 9, 12, 'bar')])
    expect(result).toBe('bar(bar, bar)\n')
  })

  it('applies edits given in arbitrary order', () => {
    const text = 'alpha\nbeta\ngamma\n'
    const result = applyTextEdits(text, [edit(2, 0, 5, 'GAMMA'), edit(0, 0, 5, 'ALPHA')])
    expect(result).toBe('ALPHA\nbeta\nGAMMA\n')
  })

  it('applies an edit spanning multiple lines', () => {
    const text = 'one\ntwo\nthree\n'
    const result = applyTextEdits(text, [
      { range: { start: { line: 0, character: 1 }, end: { line: 2, character: 2 } }, newText: 'X' },
    ])
    expect(result).toBe('oXree\n')
  })

  it('handles insertions at a zero-width range', () => {
    const text = 'ab\n'
    const result = applyTextEdits(text, [edit(0, 1, 1, '-')])
    expect(result).toBe('a-b\n')
  })

  it('clamps positions past the end of a line or document', () => {
    const text = 'ab\n'
    const result = applyTextEdits(text, [
      { range: { start: { line: 9, character: 9 }, end: { line: 9, character: 9 } }, newText: '!' },
    ])
    expect(result).toBe('ab\n!')
  })

  it('returns the input unchanged for an empty edit list', () => {
    expect(applyTextEdits('unchanged\n', [])).toBe('unchanged\n')
  })
})
