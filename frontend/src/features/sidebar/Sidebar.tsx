import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { fmtRupiah } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useWorkspace } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'
import { Tooltip } from '@/components/ui/tooltip'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { SidebarNav } from './SidebarNav'
import { ProjectTree } from './ProjectTree'

interface SidebarProps {
  /** Collapses the sidebar to a ~44px icon rail (workspace-mode chrome collapse). */
  compact?: boolean
}

export function Sidebar({ compact }: SidebarProps = {}) {
  const sidebarOpen = useLoomStore((s) => s.sidebarOpen)
  const setSidebarOpen = useLoomStore((s) => s.setSidebarOpen)

  if (compact) return <SidebarRail />

  return (
    <>
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-[rgba(6,7,9,0.55)] md:hidden"
        />
      )}
      <aside
        className={cn(
          'flex flex-col border-r border-loom-border bg-loom-surface',
          'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-[45] max-md:w-[298px] max-md:max-w-[86vw]',
          'max-md:shadow-[8px_0_40px_rgba(0,0,0,0.55)] max-md:transition-transform max-md:duration-200',
          sidebarOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full',
          'md:w-[298px] md:flex-none md:translate-x-0',
        )}
      >
        <WorkspaceSwitcher />
        <SidebarNav />
        <SidebarBody />
      </aside>
    </>
  )
}

/**
 * Collapsed icon rail shown instead of the full sidebar while a worktree is
 * open (workspace mode). Always visible — desktop and mobile alike — since
 * it's the only way back once the Header's hamburger is hidden; it does not
 * use the mobile drawer/`sidebarOpen` mechanism at all.
 */
function SidebarRail() {
  const navigate = useNavigate()
  const { wsId, projectId } = useScope()
  const dirtyFileCount = useLoomStore((s) => s.dirtyFileCount)

  function goBack() {
    if (!wsId || !projectId) return
    if (dirtyFileCount > 0 && !window.confirm('Leave this terminal with unsaved files?')) return
    navigate({ to: '/w/$wsId/p/$projectId', params: { wsId, projectId } })
  }

  return (
    <aside className="flex w-11 flex-none flex-col items-center gap-1 border-r border-loom-border bg-loom-surface py-2">
      <Tooltip label="Back to worktrees" side="right">
        <button
          onClick={goBack}
          aria-label="Back to worktrees"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-loom-muted transition-colors hover:bg-loom-hover-wash hover:text-loom-fg"
        >
          <ArrowLeft size={16} />
        </button>
      </Tooltip>
      <WorkspaceSwitcher compact />
      <SidebarNav compact />
    </aside>
  )
}

function SidebarBody() {
  const { view } = useScope()
  if (view === 'agents') return <ProjectTree />
  if (view === 'tools' || view === 'management') return <div className="flex-1" />
  return <ModuleAside />
}

function ModuleAside() {
  const { wsId, view } = useScope()
  const ws = useWorkspace(wsId).data
  if (!ws) return <div className="flex-1" />

  let title = ''
  let rows: { k: string; v: string }[] = []
  if (view === 'news') {
    const unread = ws.news.filter((n) => n.unread).length
    title = 'NEWS'
    rows = [
      { k: 'Unread', v: String(unread) },
      { k: 'Total', v: String(ws.news.length) },
    ]
  } else if (view === 'todos') {
    const active = ws.todos.filter((t) => !t.done).length
    title = 'TODOS'
    rows = [
      { k: 'Active', v: String(active) },
      { k: 'Done', v: String(ws.todos.length - active) },
    ]
  } else if (view === 'invoices') {
    const outstanding = ws.invoices.filter((iv) => iv.status === 'sent' || iv.status === 'overdue').reduce((a, iv) => a + iv.amount, 0)
    const overdue = ws.invoices.filter((iv) => iv.status === 'overdue').reduce((a, iv) => a + iv.amount, 0)
    title = 'INVOICES'
    rows = [
      { k: 'Outstanding', v: fmtRupiah(outstanding) },
      { k: 'Overdue', v: fmtRupiah(overdue) },
    ]
  }

  return (
    <div className="flex-1 overflow-auto p-3">
      <div className="px-1 pb-2.5 pt-0.5 font-mono text-[10.5px] tracking-[0.14em] text-loom-dim">{title}</div>
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <div
            key={r.k}
            className="flex items-center justify-between rounded-[10px] border border-loom-border-card bg-loom-surface-2 px-3 py-2.5"
          >
            <span className="text-[12px] text-loom-muted">{r.k}</span>
            <span className="font-mono text-[12.5px] font-semibold text-loom-fg">{r.v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
