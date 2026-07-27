/** Pure helpers behind DBSqlEditor's Format button, history rows, and
 *  schema-aware autocomplete.
 *
 *  Kept out of the component so they are testable without a DOM — see
 *  `npx tsx src/features/database/sqlEditorSupport.test.ts`.
 */

import type { DBColumnMeta, DBObjectRef, DBTreeNode, DBTreePath } from '@/lib/api'
import type { DBEngine } from '@/store/types'

/** sql-formatter's dialect id for an engine. Typed as its `SqlLanguage`
 *  union so a typo is a compile error rather than a runtime ConfigError. */
export function sqlFormatterLanguage(engine: DBEngine): 'postgresql' | 'mysql' | 'sqlite' {
  switch (engine) {
    case 'postgres':
      return 'postgresql'
    case 'mysql':
      return 'mysql'
    case 'sqlite':
      return 'sqlite'
  }
}

/** The first non-empty line of a statement, for a one-line history row.
 *  Appends an ellipsis when anything was dropped (a later line, or an
 *  over-long first line) so a truncated row is visibly truncated. */
export function firstSQLLine(sql: string, maxChars = 90): string {
  const lines = sql.split(/\r?\n/)
  const idx = lines.findIndex((l) => l.trim() !== '')
  if (idx === -1) return ''
  const head = lines[idx].trim()
  const hasMore = lines.slice(idx + 1).some((l) => l.trim() !== '')
  if (head.length > maxChars) return `${head.slice(0, maxChars)}…`
  return hasMore ? `${head}…` : head
}

/** Parses a history entry's `executedAt` (RFC3339, UTC), returning null when
 *  it is unparseable.
 *
 *  Not just `new Date(s)` at the call site: date-fns's formatDistanceToNow
 *  throws a RangeError on an Invalid Date, and one malformed row must not take
 *  the whole editor tab down with it. */
export function parseExecutedAt(executedAt: string): Date | null {
  const d = new Date(executedAt)
  return Number.isNaN(d.getTime()) ? null : d
}

/** A CodeMirror `SQLNamespace`, narrowed to the two shapes we build: a table
 *  is a list of column names, a schema is a map of tables. */
export type SQLSchemaMap = Record<string, string[] | Record<string, string[]>>

/** One `[queryKey, data]` pair as react-query's `getQueriesData` returns it.
 *  Data is `unknown` because a cache read is untyped and may be `undefined`
 *  for a query that has not resolved. */
export type CacheEntry = readonly [readonly unknown[], unknown]

/** Tree collections whose children are relations you can select from.
 *  'databases'/'schemas'/'functions' levels are deliberately absent: a
 *  database or schema name is not a table, and completing a function as one
 *  would put it in the FROM-clause namespace. */
const RELATION_COLLECTIONS = new Set(['tables', 'views', 'matviews'])

function descriptorOf(key: readonly unknown[], index: number): Record<string, unknown> | null {
  const raw = key[index]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Builds the autocomplete schema from data react-query has ALREADY cached —
 *  the object tree's expanded branches and any column list the inspector or a
 *  grid tab loaded. It never fetches: an editor keystroke must not turn into a
 *  metadata round-trip, and an empty cache degrading to plain keyword
 *  completion is the correct behavior, not a bug.
 *
 *  Every table is registered twice when it lives in a named schema — bare
 *  (`users`) and qualified (`public.users`) — because an operator writes
 *  whichever the search_path makes valid. When two schemas hold the same table
 *  name, the bare entry keeps whichever list actually has columns; a column
 *  list is strictly more useful than an empty one and there is no way to tell
 *  which schema the writer meant.
 *
 *  @param treeEntries  cache entries under the `['db', id, 'tree', path]` key
 *  @param columnEntries cache entries under `['db', id, 'columns', object]`
 */
export function buildSQLSchema(treeEntries: CacheEntry[], columnEntries: CacheEntry[]): SQLSchemaMap {
  // schemaName ('' for schema-less engines) -> table -> columns
  const bySchema = new Map<string, Map<string, string[]>>()

  function table(schema: string, name: string): string[] {
    let tables = bySchema.get(schema)
    if (!tables) {
      tables = new Map<string, string[]>()
      bySchema.set(schema, tables)
    }
    let cols = tables.get(name)
    if (!cols) {
      cols = []
      tables.set(name, cols)
    }
    return cols
  }

  for (const [key, data] of treeEntries) {
    if (!Array.isArray(data)) continue
    const path = descriptorOf(key, 3) as DBTreePath | null
    if (!path) continue
    if (!RELATION_COLLECTIONS.has(str(path.kind))) continue
    for (const node of data as DBTreeNode[]) {
      const name = str(node?.name)
      if (name) table(str(path.schema), name)
    }
  }

  for (const [key, data] of columnEntries) {
    if (!Array.isArray(data)) continue
    const object = descriptorOf(key, 3) as DBObjectRef | null
    if (!object) continue
    const name = str(object.name)
    if (!name) continue
    const cols = table(str(object.schema), name)
    for (const c of data as DBColumnMeta[]) {
      const col = str(c?.name)
      if (col && !cols.includes(col)) cols.push(col)
    }
  }

  const out: SQLSchemaMap = {}
  // Bare names are written first so a qualified container ({users: [...]}) can
  // overwrite a same-named bare table entry below rather than the reverse —
  // losing `public.` completion is worse than losing one bare duplicate.
  for (const [schemaName, tables] of bySchema) {
    for (const [name, cols] of tables) {
      const existing = out[name]
      if (Array.isArray(existing) && existing.length > 0 && cols.length === 0) continue
      if (existing !== undefined && !Array.isArray(existing)) continue
      out[name] = cols
    }
    if (schemaName) {
      out[schemaName] = Object.fromEntries(tables)
    }
  }
  return out
}
