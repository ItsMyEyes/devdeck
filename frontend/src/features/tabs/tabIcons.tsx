import {
  Cable,
  Database,
  Folder,
  GitBranch,
  Globe,
  LayoutGrid,
  ListTodo,
  Newspaper,
  Receipt,
  Server,
  Settings,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TileTab } from '@/features/tabs/tileTree'

/**
 * One icon per parent menu, keyed by the workspace route the menu opens
 * (`w.$wsId.*`, `''` being Agents).
 *
 * This is the single source of truth every surface that names a menu's
 * children must read — the tab strip's pills and the command palette's rows
 * included. Spelling an icon inline instead is how a saved SSH host ended up
 * as a `Network` glyph in the palette while the same host's tab and its
 * sidebar group both showed `Cable`.
 */
export const MODULE_ICON = {
  agents: LayoutGrid,
  machines: Server,
  ssh: Cable,
  browser: Globe,
  tools: Wrench,
  database: Database,
  todos: ListTodo,
  invoices: Receipt,
  news: Newspaper,
  management: Settings,
} as const satisfies Record<string, LucideIcon>

/** The two rungs below Agents, matching the sidebar tree: a project folder,
 *  and `WorktreeGlyph`'s branch marker for a worktree under it. */
export const PROJECT_ICON: LucideIcon = Folder
export const WORKTREE_ICON: LucideIcon = GitBranch

/** The icon a tab inherits from the menu it was opened from. */
export const TAB_KIND_ICON: Record<TileTab['kind'], LucideIcon> = {
  agents: MODULE_ICON.agents,
  worktree: WORKTREE_ICON,
  browser: MODULE_ICON.browser,
  'ssh-shell': MODULE_ICON.ssh,
}

/** `TAB_KIND_ICON` rendered at the tab strip's size — the pills, their drag
 *  ghost and the palette's Open tabs rows all show the same glyph. */
export function TabKindIcon({
  kind,
  size = 12,
  className,
}: {
  kind: TileTab['kind']
  size?: number
  className?: string
}) {
  const Icon = TAB_KIND_ICON[kind]
  return <Icon size={size} className={cn('flex-none', className)} />
}
