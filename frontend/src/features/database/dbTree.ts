import type { DBCaps } from '@/lib/api'

/** childCollections maps a parent's kind to the TreePath.kind of its
 *  children, per the engine's capability flags — a schema-less engine
 *  (mysql, sqlite) skips straight from "databases"/root to "tables"/"views".
 *
 *  The root call passes '' and gets back a *collection* kind ('databases',
 *  'schemas', …) — the plural string also used as TreePath.kind when
 *  fetching that collection. Every other call passes a tree *node*'s own
 *  kind, which the backend always names in the singular ('database',
 *  'schema' — see pgdrv/mysqldrv's Tree()), so the two branches below match
 *  singular, not plural.
 */
export function childCollections(caps: DBCaps, parentKind: string): string[] {
  if (parentKind === '') {
    if (caps.multiDatabase) return ['databases']
    if (caps.schemas) return ['schemas']
    return ['tables', 'views']
  }
  if (parentKind === 'database') return caps.schemas ? ['schemas'] : ['tables', 'views']
  if (parentKind === 'schema') {
    const kinds = ['tables', 'views']
    if (caps.matViews) kinds.push('matviews')
    if (caps.functions) kinds.push('functions')
    return kinds
  }
  return []
}
