import type { SQLSchemaMap } from './sqlEditorSupport'

export interface SqlCompletionItem {
  label: string
  kind: 'table' | 'column' | 'schema'
  detail: string
}

/**
 * Replaces `@codemirror/lang-sql`'s schema-aware completion, which monaco has no
 * equivalent for — its bundled SQL support is a monarch tokenizer only.
 * Pure, so the prefix rules are testable without an editor; the caller adapts
 * the result to `monaco.languages.CompletionItem`.
 *
 * `SQLSchemaMap` is a union: a top-level value is either a bare table's column
 * list or a schema's map of tables, and buildSQLSchema emits both at once. Every
 * branch here keys off `Array.isArray`.
 */
export function sqlCompletionItems(
  schema: SQLSchemaMap,
  prefix: string | null,
): SqlCompletionItem[] {
  if (prefix) {
    const key = Object.keys(schema).find((name) => name.toLowerCase() === prefix.toLowerCase())
    if (key === undefined) return []
    const value = schema[key]
    // A bare table -> its columns. A schema -> the tables inside it.
    return Array.isArray(value)
      ? value.map((column) => ({ label: column, kind: 'column' as const, detail: key }))
      : Object.keys(value).map((table) => ({
          label: table,
          kind: 'table' as const,
          detail: key,
        }))
  }

  return Object.entries(schema).map(([name, value]) => ({
    label: name,
    kind: Array.isArray(value) ? ('table' as const) : ('schema' as const),
    detail: Array.isArray(value) ? 'table' : 'schema',
  }))
}
