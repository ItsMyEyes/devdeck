import { useLocation, useParams } from '@tanstack/react-router'
import { findTileLeaf } from '@/features/tabs/tileTree'
import { useIsTauri } from '@/features/tabs/useIsTauri'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { ModuleView } from '@/store/types'

export interface Scope {
  wsId?: string
  projectId?: string
  wtId?: string
  view: ModuleView
}

/** Derive the current scope (workspace/project/worktree/module) from the URL. */
export function useScope(): Scope {
  const params = useParams({ strict: false }) as {
    wsId?: string
    projectId?: string
    wtId?: string
  }
  const pathname = useLocation({ select: (l) => l.pathname })
  // The pinned Agents tab and every ssh-shell tab both resolve to the bare
  // `/w/$wsId` route (WorkspaceTileArea.navigateToTab can't send ssh-shell
  // tabs anywhere else without hiding the tiling canvas behind the SSH
  // connections page) — the focused tile tab's kind is the only way to
  // tell them apart, so it breaks the tie below.
  //
  // Only inside Tauri, though: `w.$wsId.tsx` mounts WorkspaceTileArea on
  // `isTauri` alone, so on the web `/w/$wsId` always renders the agents list
  // through `<Outlet/>` no matter what the tile tree says. The layout is
  // persisted (`workspaceTileLayouts` in the `devdeck-ui-v2` partialize), and
  // the palette's "open SSH host" action writes an ssh-shell tab into it
  // before navigating here — so on the web an unconditional tie-break pinned
  // the sidebar to SSHGroupTree ("GROUPS"/"New SSH host") while the agents
  // list was on screen, permanently: the only control that re-selects the
  // Agents tab lives inside ProjectTree, the panel it had just replaced.
  const isTauri = useIsTauri()
  const focusedTabKind = useDevDeckStore((s) => {
    if (!isTauri) return undefined
    const layout = params.wsId ? s.workspaceTileLayouts[params.wsId] : undefined
    if (!layout) return undefined
    const leaf = findTileLeaf(layout.root, layout.focusedLeafId)
    return leaf?.type === 'leaf' ? leaf.tabs.find((t) => t.id === leaf.activeTabId)?.kind : undefined
  })
  let view: ModuleView = 'agents'
  if (pathname.includes('/management')) view = 'management'
  else if (pathname.includes('/news')) view = 'news'
  else if (pathname.includes('/todos')) view = 'todos'
  else if (pathname.includes('/invoices')) view = 'invoices'
  else if (pathname.includes('/browser')) view = 'browser'
  else if (pathname.includes('/tools')) view = 'tools'
  else if (pathname.includes('/machines')) view = 'machines'
  else if (pathname.includes('/ssh')) view = 'ssh'
  else if (pathname.includes('/database')) view = 'database'
  else if (pathname.includes('/memory')) view = 'memory'
  else if (focusedTabKind === 'ssh-shell') view = 'ssh'
  return { wsId: params.wsId, projectId: params.projectId, wtId: params.wtId, view }
}
