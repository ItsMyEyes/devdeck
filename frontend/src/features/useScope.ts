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
  let view: ModuleView = 'agents'
  if (pathname.includes('/management')) view = 'management'
  else if (pathname.includes('/news')) view = 'news'
  else if (pathname.includes('/todos')) view = 'todos'
  else if (pathname.includes('/invoices')) view = 'invoices'
  else if (pathname.includes('/browser')) view = 'browser'
  else if (pathname.includes('/tools')) view = 'tools'
  return { wsId: params.wsId, projectId: params.projectId, wtId: params.wtId, view }
}
