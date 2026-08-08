import { Outlet, createFileRoute, redirect, useLocation, useNavigate } from '@tanstack/react-router'
import { fetchWorkspaces } from '@/lib/api'
import { qk } from '@/features/data/keys'
import { AgentsBreadcrumb } from '@/features/agents/AgentsBreadcrumb'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/w/$wsId/p/$projectId')({
  beforeLoad: async ({ context, params }) => {
    const qc = context.queryClient
    let workspaces
    try {
      workspaces = await qc.ensureQueryData({ queryKey: qk.workspaces, queryFn: fetchWorkspaces })
    } catch {
      return // backend down — parent layout renders the error state
    }
    const ws = workspaces.find((w) => w.id === params.wsId)
    if (ws && !ws.projects.some((p) => p.id === params.projectId)) {
      throw redirect({ to: '/w/$wsId', params: { wsId: params.wsId } })
    }
  },
  component: ProjectLayout,
})

const TABS = [
  { to: '/w/$wsId/p/$projectId', label: 'Worktrees', match: (path: string) => !path.includes('/issues') },
  { to: '/w/$wsId/p/$projectId/issues', label: 'Issues', match: (path: string) => path.includes('/issues') },
] as const

function ProjectLayout() {
  const { wsId, projectId } = Route.useParams()
  const navigate = useNavigate()
  const pathname = useLocation({ select: (l) => l.pathname })
  const inWorktree = pathname.includes('/wt/')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentsBreadcrumb />
      {inWorktree ? null : (
        <div className="flex flex-none items-center gap-1 border-b border-devdeck-border px-4 py-1.5">
          {TABS.map((tab) => (
            <button
              key={tab.to}
              type="button"
              onClick={() => navigate({ to: tab.to, params: { wsId, projectId } })}
              className={cn(
                'cursor-pointer rounded-md px-2.5 py-1 font-mono text-[11.5px] transition-colors',
                tab.match(pathname) ? 'bg-devdeck-glass-solid text-devdeck-fg' : 'text-devdeck-fg-2 hover:text-devdeck-fg-2',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      <Outlet />
    </div>
  )
}
