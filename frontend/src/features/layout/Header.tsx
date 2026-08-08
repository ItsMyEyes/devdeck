import { Check, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DevDeckLogo } from '@/features/branding/DevDeckLogo'
import { useScope } from '@/features/useScope'
import { useMarkAllNewsRead, useSettings, useWorkspace } from '@/features/data/queries'
import { useDevDeckStore } from '@/store/useDevDeckStore'

export function Header() {
  const { wsId, projectId, view } = useScope()
  const ws = useWorkspace(wsId).data
  const defaultModel = useSettings().data?.defaultModel ?? 'claude-sonnet-5'
  const setSidebarOpen = useDevDeckStore((s) => s.setSidebarOpen)
  const openSpawn = useDevDeckStore((s) => s.openSpawn)
  const showToast = useDevDeckStore((s) => s.showToast)
  const markAll = useMarkAllNewsRead()

  const worktrees = ws ? ws.projects.flatMap((p) => p.worktrees) : []
  const running = worktrees.filter((w) => w.state === 'running').length
  const waiting = worktrees.filter((w) => w.state === 'waiting').length
  const errors = worktrees.filter((w) => w.state === 'error').length

  const agents = view === 'agents'

  function spawnWorktree() {
    if (!ws?.projects.length) {
      showToast('Add a project first')
      return
    }
    const selectedProject = ws.projects.find((project) => project.id === projectId)
    openSpawn(selectedProject?.id ?? null, 'branch', defaultModel)
  }

  function markRead() {
    if (!wsId) return
    markAll.mutate(wsId, { onSuccess: () => showToast('All caught up') })
  }

  return (
    <header className="flex h-[54px] flex-none items-center gap-3.5 border-b border-devdeck-border bg-devdeck-pane px-3.5">
      {/* mobile sidebar toggle */}
      <button
        onClick={() => setSidebarOpen(true)}
        aria-label="Open sidebar"
        className="flex h-[34px] w-[34px] flex-none cursor-pointer flex-col items-center justify-center gap-[3.5px] rounded-lg border border-devdeck-border-strong bg-transparent md:hidden"
      >
        <span className="h-[1.6px] w-[15px] rounded-sm bg-devdeck-fg-2" />
        <span className="h-[1.6px] w-[15px] rounded-sm bg-devdeck-fg-2" />
        <span className="h-[1.6px] w-[15px] rounded-sm bg-devdeck-fg-2" />
      </button>

      {/* brand */}
      <div className="flex items-center gap-2.5">
        <DevDeckLogo />
        <span className="text-[15px] font-semibold tracking-[-0.02em]">devdeck</span>
        <span className="ml-0.5 hidden rounded-micro border border-devdeck-border-strong px-1.5 py-0.5 font-mono text-[10.5px] text-devdeck-fg-2 md:inline">
          one operator · many companies
        </span>
      </div>

      {/* live agent counts */}
      {agents && (
        <div className="ml-1 hidden items-center gap-3.5 font-mono text-[11.5px] text-devdeck-fg-2 md:flex">
          <span className="flex items-center gap-1.5">
            <span className="h-[7px] w-[7px] rounded-full bg-devdeck-green" />
            {running} running
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-[7px] w-[7px] rounded-full bg-devdeck-yellow" />
            {waiting} waiting
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-[7px] w-[7px] rounded-full bg-devdeck-red" />
            {errors} error
          </span>
        </div>
      )}

      <div className="flex-1" />
    </header>
  )
}

interface PrimaryActionProps {
  view: string
  newsCount: number
  onWorktree: () => void
  onMarkRead: () => void
}

function PrimaryAction({ view, newsCount, onWorktree, onMarkRead }: PrimaryActionProps) {
  if (view === 'todos' || view === 'management' || view === 'tools') return null
  // Invoice creation is owned by the invoices module (local form state), so the
  // top header exposes no primary action on that view.
  if (view === 'invoices') return null
  if (view === 'news') {
    if (newsCount === 0) return null
    return (
      <Button variant="secondary" onClick={onMarkRead}>
        <Check size={14} />
        Mark all read
      </Button>
    )
  }
  return (
    /* accent-soft, not solid: this button is on screen on every route, so a
       saturated fill here competes with whatever action the current module is
       actually for (Add runtime, New connection). The solid accent belongs to
       the page; this keeps the accent identity one step down. */
    <Button variant="accent-soft" onClick={onWorktree}>
      <Plus size={15} />
      Worktree
    </Button>
  )
}
