import type { LucideIcon } from 'lucide-react'
import type { HighlightRange } from '@/lib/fuzzyHighlight'

export type PaletteGroup = 'open' | 'recent' | 'results' | 'create'

export type PaletteItemKind =
  | 'open-tab'
  | 'worktree'
  | 'ssh-host'
  | 'project'
  | 'machine'
  | 'page'
  | 'bookmark'
  | 'url'
  | 'create'
  | 'command'

/** A single selectable row. `run` performs the action; `drillInto` pushes a
 *  sub-page. An item with neither is inert and must not be produced. */
export interface PaletteItem {
  id: string
  kind: PaletteItemKind
  title: string
  subtitle?: string
  /** Extra text matched alongside `title` — host, IP, project name. */
  keywords?: string[]
  /** Matched like `keywords`, but with the subsequence fallback disabled —
   *  for long haystacks (filesystem paths) where a subsequence match is
   *  near-universal and would make every row match every query. */
  literalKeywords?: string[]
  group: PaletteGroup
  icon?: LucideIcon
  /** Rendered greyed out; `run` is refused and the reason is toasted. */
  disabled?: { reason: string }
  /** Ghost text shown in the input while this item is selected. */
  completion?: string
  run?: (ctx: PaletteRunContext) => void | Promise<void>
  drillInto?: () => PalettePage
}

export interface PalettePage {
  id: string
  breadcrumb: string
  placeholder: string
  items: (query: string, ctx: PaletteRunContext) => PaletteItem[]
}

export interface PaletteRunContext {
  wsId: string
  /** The focused leaf — every action targets it. */
  leafId: string
  showToast: (message: string) => void
  close: () => void
}

export type RankedItem = PaletteItem & { score: number; ranges: HighlightRange[] }

export interface RankedGroup {
  group: PaletteGroup
  label: string
  items: RankedItem[]
  /** How many matches were dropped by the per-group cap. */
  truncated: number
}
