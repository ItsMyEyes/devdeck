import { describe, expect, it } from 'vitest'
import { languageForPath } from './languageForPath'

describe('languageForPath', () => {
  it('maps common source extensions', () => {
    expect(languageForPath('src/main.go')).toBe('go')
    expect(languageForPath('a/b/App.tsx')).toBe('typescript')
    expect(languageForPath('index.ts')).toBe('typescript')
    expect(languageForPath('script.js')).toBe('javascript')
    expect(languageForPath('mod.rs')).toBe('rust')
    expect(languageForPath('main.py')).toBe('python')
    expect(languageForPath('Main.java')).toBe('java')
    expect(languageForPath('q.sql')).toBe('sql')
    expect(languageForPath('notes.md')).toBe('markdown')
    expect(languageForPath('tsconfig.json')).toBe('json')
  })

  it('matches well-known filenames that have no extension', () => {
    expect(languageForPath('Dockerfile')).toBe('dockerfile')
    expect(languageForPath('deep/path/Makefile')).toBe('makefile')
  })

  it('is case-insensitive on the extension', () => {
    expect(languageForPath('README.MD')).toBe('markdown')
  })

  it('falls back to plaintext', () => {
    expect(languageForPath('LICENSE')).toBe('plaintext')
    expect(languageForPath('data.unknownext')).toBe('plaintext')
    expect(languageForPath('')).toBe('plaintext')
  })
})
