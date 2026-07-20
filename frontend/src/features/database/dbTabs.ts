import type { DBObjectRef } from '@/lib/api'

export type DBTabContent =
  | { id: string; kind: 'table'; object: DBObjectRef }
  | { id: string; kind: 'ddl'; object: DBObjectRef }
  | { id: string; kind: 'query'; savedQueryId: string | null; label: string }

/** Plain `Omit<T, K>` does not distribute over a discriminated union — since
 *  `keyof DBTabContent` only includes keys common to every arm (`id`,
 *  `kind`), `Omit<DBTabContent, 'id'>` would collapse to `{ kind: ... }` and
 *  silently drop `object`/`savedQueryId`/`label`. Distribute manually. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type DBTabDraft = DistributiveOmit<DBTabContent, 'id'>

export interface DBTabState {
  tabs: DBTabContent[]
  activeTabId: string | null
}

export function emptyDBTabState(): DBTabState {
  return { tabs: [], activeTabId: null }
}

function objectKey(object: DBObjectRef) {
  return `${object.database}.${object.schema}.${object.name}`
}

/** Computes the identity a piece of tab content dedupes on — opening the same
 *  table twice (or the same saved query) must focus the existing tab rather
 *  than opening a second one. */
export function tabId(content: DBTabDraft): string {
  if (content.kind === 'table') return `table:${objectKey(content.object)}`
  if (content.kind === 'ddl') return `ddl:${objectKey(content.object)}`
  return `query:${content.savedQueryId ?? 'draft'}`
}

export function openTab(state: DBTabState, content: DBTabDraft): DBTabState {
  const id = tabId(content)
  if (state.tabs.some((t) => t.id === id)) return { ...state, activeTabId: id }
  const tab = { ...content, id } as DBTabContent
  return { tabs: [...state.tabs, tab], activeTabId: id }
}

export function closeTab(state: DBTabState, id: string): DBTabState {
  const closedIndex = state.tabs.findIndex((t) => t.id === id)
  if (closedIndex === -1) return state
  const tabs = state.tabs.filter((t) => t.id !== id)
  if (state.activeTabId !== id) return { tabs, activeTabId: state.activeTabId }
  const fallback = tabs[closedIndex] ?? tabs[closedIndex - 1] ?? null
  return { tabs, activeTabId: fallback ? fallback.id : null }
}

export function setActiveTab(state: DBTabState, id: string): DBTabState {
  return state.tabs.some((t) => t.id === id) ? { ...state, activeTabId: id } : state
}
