import { describe, expect, it } from 'vitest'
import {
  findDefinition,
  findImportedSource,
  quotedPathAt,
  resolveImportBase,
} from './definitionFallback'

describe('findDefinition', () => {
  it('finds a function declaration', () => {
    const source = 'const a = 1\nfunction target() {}\n'
    const found = findDefinition(source, 'target')
    expect(source.slice(found!.from, found!.to)).toBe('target')
  })

  it('finds a Go func with a receiver', () => {
    const source = 'func (s *Server) Handle() {}\n'
    const found = findDefinition(source, 'Handle')
    expect(source.slice(found!.from, found!.to)).toBe('Handle')
  })

  it('finds a type declaration', () => {
    const source = 'interface Widget { a: number }\n'
    expect(findDefinition(source, 'Widget')).not.toBeNull()
  })

  it('returns null for an unknown symbol', () => {
    expect(findDefinition('const a = 1', 'missing')).toBeNull()
  })

  it('rejects a symbol that is not an identifier', () => {
    expect(findDefinition('const a = 1', 'a b')).toBeNull()
  })
})

describe('findImportedSource', () => {
  it('finds the module a symbol was imported from', () => {
    const source = "import { Widget } from './widget'\n"
    expect(findImportedSource(source, 'Widget')).toEqual({
      source: './widget',
      revealSymbol: 'Widget',
    })
  })

  it('resolves an aliased import back to its original name', () => {
    const source = "import { Inner as Outer } from './inner'\n"
    expect(findImportedSource(source, 'Outer')).toEqual({
      source: './inner',
      revealSymbol: 'Inner',
    })
  })

  it('handles require()', () => {
    const source = "const fs = require('node:fs')\n"
    expect(findImportedSource(source, 'fs')?.source).toBe('node:fs')
  })

  it('returns null when the symbol was not imported', () => {
    expect(findImportedSource("import { A } from './a'", 'B')).toBeNull()
  })
})

describe('quotedPathAt', () => {
  it('returns the quoted string under the cursor', () => {
    const source = "import x from './target'\n"
    const position = source.indexOf('target')
    expect(quotedPathAt(source, position)).toBe('./target')
  })

  it('returns null when the cursor is outside any quoted string', () => {
    const source = "import x from './target'\n"
    expect(quotedPathAt(source, 2)).toBeNull()
  })
})

describe('resolveImportBase', () => {
  it('resolves the @/ alias to src/', () => {
    expect(resolveImportBase('src/a/b.ts', '@/lib/util')).toBe('src/lib/util')
  })

  it('resolves a relative sibling', () => {
    expect(resolveImportBase('src/a/b.ts', './c')).toBe('src/a/c')
  })

  it('resolves a relative parent', () => {
    expect(resolveImportBase('src/a/b.ts', '../c')).toBe('src/c')
  })

  it('strips a query string', () => {
    expect(resolveImportBase('src/a/b.ts', './c?raw')).toBe('src/a/c')
  })

  it('returns null for a bare package specifier', () => {
    expect(resolveImportBase('src/a/b.ts', 'react')).toBeNull()
  })
})
