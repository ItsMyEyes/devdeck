import { Check, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoomLogo } from '@/features/branding/LoomLogo'
import { useScope } from '@/features/useScope'
import { useMarkAllNewsRead, useSettings, useWorkspace } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

export function Header() {
  const { wsId, view } = useScope()
  const ws = useWorkspace(wsId).data
  const defaultModel = useSettings().data?.defaultModel ?? 'claude-sonnet-5'
  const setSidebarOpen = useLoomStore((s) => s.setSidebarOpen)
  const openSpawn = useLoomStore((s) => s.openSpawn)
  const showToast = useLoomStore((s) => s.showToast)
  const markAll = useMarkAllNewsRead()

  const worktrees = ws ? ws.projects.flatMap((p) => p.worktrees) : []
  const running = worktrees.filter((w) => w.state === 'running').length
  const waiting = worktrees.filter((w) => w.state === 'waiting').length
  const errors = worktrees.filter((w) => w.state === 'error').length

  const agents = view === 'agents'

  function spawnWorktree() {
    const first = ws?.projects[0]
    if (!first) {
      showToast('Add a project first')
      return
    }
    openSpawn(first.id, 'branch', defaultModel)
  }

  function markRead() {
    if (!wsId) return
    markAll.mutate(wsId, { onSuccess: () => showToast('All caught up') })
  }

  return (
    <header className="flex h-[54px] flex-none items-center gap-3.5 border-b border-loom-border bg-loom-surface px-3.5">
      {/* mobile sidebar toggle */}
      <button
        onClick={() => setSidebarOpen(true)}
        aria-label="Open sidebar"
        className="flex h-[34px] w-[34px] flex-none cursor-pointer flex-col items-center justify-center gap-[3.5px] rounded-lg border border-loom-border-strong bg-transparent md:hidden"
      >
        <span className="h-[1.6px] w-[15px] rounded-sm bg-loom-fg-2" />
        <span className="h-[1.6px] w-[15px] rounded-sm bg-loom-fg-2" />
        <span className="h-[1.6px] w-[15px] rounded-sm bg-loom-fg-2" />
      </button>

      {/* brand */}
      <div className="flex items-center gap-2.5">
        <LoomLogo />
        <span className="text-[15px] font-semibold tracking-[-0.02em]">loom</span>
        <span className="ml-0.5 hidden rounded-[5px] border border-loom-border-strong px-1.5 py-0.5 font-mono text-[10.5px] text-loom-dim md:inline">
          one operator · many companies
        </span>
      </div>

      {/* live agent counts */}
      {agents && (
        <div className="ml-1 hidden items-center gap-3.5 font-mono text-[11.5px] text-loom-muted md:flex">
          <span className="flex items-center gap-1.5">
            <span className="h-[7px] w-[7px] rounded-full bg-loom-green" />
            {running} running
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-[7px] w-[7px] rounded-full bg-loom-yellow" />
            {waiting} waiting
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-[7px] w-[7px] rounded-full bg-loom-red" />
            {errors} error
          </span>
        </div>
      )}

      <div className="flex-1" />

      <PrimaryAction
        view={view}
        newsCount={ws?.news.length ?? 0}
        onWorktree={spawnWorktree}
        onMarkRead={markRead}
      />
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
    <Button onClick={onWorktree}>
      <Plus size={15} />
      Worktree
    </Button>
  )
}
