import { searchWorktreeFiles } from '@/lib/machineApi'
import type { Machine } from '@/store/types'

/**
 * Regex/import go-to-definition heuristics, extracted unchanged from
 * `CodeFileEditor.tsx`. With no language server attached, these are the whole
 * go-to-definition feature; with one attached, they remain the fallback when
 * an LSP definition request comes back empty. They operate purely on strings
 * and worktree search results, never on editor state, which is what makes
 * them unit-testable without mounting an editor.
 */

interface DefinitionRange {
  from: number
  to: number
}

const candidateExtensions = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'go',
  'py',
  'rs',
  'java',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'vue',
  'svelte',
  'yaml',
  'yml',
  'toml',
  'sql',
]

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function identifierRegex(symbol: string) {
  return new RegExp(`\\b${escapeRegex(symbol)}\\b`)
}

function normalizeWorkspacePath(value: string) {
  const normalized: string[] = []
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (normalized.length === 0) return null
      normalized.pop()
    } else {
      normalized.push(part)
    }
  }
  return normalized.join('/')
}

export function resolveImportBase(currentPath: string, source: string) {
  const cleanSource = source.replace(/[?#].*$/, '')
  if (cleanSource.startsWith('@/'))
    return normalizeWorkspacePath(`src/${cleanSource.slice(2)}`)
  if (cleanSource.startsWith('/'))
    return normalizeWorkspacePath(cleanSource.slice(1))
  if (!cleanSource.startsWith('.')) return null
  const currentFolder = currentPath.includes('/')
    ? currentPath.slice(0, currentPath.lastIndexOf('/'))
    : ''
  return normalizeWorkspacePath(`${currentFolder}/${cleanSource}`)
}

export async function resolveImportFile(
  machine: Machine,
  worktreeId: string,
  currentPath: string,
  source: string,
) {
  const base = resolveImportBase(currentPath, source)
  if (!base) return null

  const lastSegment = base.split('/').pop() ?? base
  const hasExtension = /\.[A-Za-z0-9]+$/.test(lastSegment)
  const candidates = hasExtension
    ? [base]
    : [
        base,
        ...candidateExtensions.map((extension) => `${base}.${extension}`),
        ...candidateExtensions.map((extension) => `${base}/index.${extension}`),
      ]
  const pattern = `^(?:${candidates.map(escapeRegex).join('|')})$`
  const matches = await searchWorktreeFiles(machine, worktreeId, pattern)
  return (
    candidates.find((candidate) => matches.includes(candidate)) ??
    matches[0] ??
    null
  )
}

export function findDefinition(
  source: string,
  symbol: string,
): DefinitionRange | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) return null
  const escaped = escapeRegex(symbol)
  const patterns = [
    new RegExp(`\\b(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`\\bfunc\\s+(?:\\([^\\n)]*\\)\\s*)?${escaped}\\b`),
    new RegExp(`\\bdef\\s+${escaped}\\b`),
    new RegExp(`\\bfn\\s+${escaped}\\b`),
    new RegExp(
      `\\b(?:class|interface|type|enum|struct|trait)\\s+${escaped}\\b`,
    ),
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(
      `(?:^|\\n)\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+)*${escaped}\\s*\\(`,
    ),
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(source)
    if (!match) continue
    const symbolOffset = match[0].lastIndexOf(symbol)
    const from = match.index + Math.max(0, symbolOffset)
    return { from, to: from + symbol.length }
  }
  return null
}

export function quotedPathAt(source: string, position: number) {
  const lineStart = source.lastIndexOf('\n', position - 1) + 1
  const lineEndMatch = source.indexOf('\n', position)
  const lineEnd = lineEndMatch < 0 ? source.length : lineEndMatch
  const line = source.slice(lineStart, lineEnd)
  const strings = /(['"`])([^'"`\n]+)\1/g

  for (const match of line.matchAll(strings)) {
    const start = lineStart + (match.index ?? 0)
    const end = start + match[0].length
    if (position > start && position < end) return match[2]
  }
  return null
}

export function findImportedSource(source: string, symbol: string) {
  const symbolPattern = identifierRegex(symbol)
  const importPatterns = [
    /import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g,
    /export\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g,
    /(?:const|let|var)\s+([^=\n]+)=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]

  for (const pattern of importPatterns) {
    for (const match of source.matchAll(pattern)) {
      if (!symbolPattern.test(match[1])) continue
      const alias = new RegExp(
        `\\b([A-Za-z_$][\\w$]*)\\s+as\\s+${escapeRegex(symbol)}\\b`,
      ).exec(match[1])
      return { source: match[2], revealSymbol: alias?.[1] ?? symbol }
    }
  }
  return null
}

/** The fallback heuristics work in string offsets; Monaco addresses everything
 *  in 1-based line/column. */
export function offsetToLineColumn(source: string, offset: number) {
  const clamped = Math.max(0, Math.min(offset, source.length))
  const before = source.slice(0, clamped)
  const line = before.split('\n').length
  const column = clamped - (before.lastIndexOf('\n') + 1) + 1
  return { line, column }
}
