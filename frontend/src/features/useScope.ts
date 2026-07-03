import { useLocation, useParams } from '@tanstack/react-router'
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
  const view: ModuleView = pathname.includes('/news')
    ? 'news'
    : pathname.includes('/todos')
      ? 'todos'
      : pathname.includes('/invoices')
        ? 'invoices'
        : pathname.includes('/tools')
          ? 'tools'
          : 'agents'
  return { wsId: params.wsId, projectId: params.projectId, wtId: params.wtId, view }
}
