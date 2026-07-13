import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
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
  /** Whether mobile shows the sidebar as a Header-hamburger-triggered overlay drawer
   *  (hidden until `sidebarOpen`). False in workspace mode, which hides the Header
   *  entirely — there the rail has no other way to be revealed, so it stays
   *  permanently visible on mobile too, same as desktop. */
  mobileDrawer?: boolean
}

/**
 * Left sidebar, global across every route: an icon-only rail by default
 * (`railExpanded` false) that widens to the full labeled sidebar on toggle.
 * The small/big toggle is independent of `sidebarOpen`, the mobile drawer's
 * open/close.
 */
export function Sidebar({ mobileDrawer = true }: SidebarProps = {}) {
  const navigate = useNavigate()
  const sidebarOpen = useLoomStore((s) => s.sidebarOpen)
  const setSidebarOpen = useLoomStore((s) => s.setSidebarOpen)
  const railExpanded = useLoomStore((s) => s.railExpanded)
  const toggleRailExpanded = useLoomStore((s) => s.toggleRailExpanded)
  const dirtyFileCount = useLoomStore((s) => s.dirtyFileCount)
  const { wsId, projectId, wtId } = useScope()

  function goBack() {
    if (!wsId || !projectId) return
    if (dirtyFileCount > 0 && !window.confirm('Leave this terminal with unsaved files?')) return
    navigate({ to: '/w/$wsId/p/$projectId', params: { wsId, projectId } })
  }

  const railButtonClass = cn(
    'flex h-9 flex-none cursor-pointer items-center rounded-lg text-loom-muted transition-colors hover:bg-loom-hover-wash hover:text-loom-fg',
    railExpanded ? 'w-full justify-start gap-2.5 px-2.5' : 'w-9 justify-center',
  )

  const toggleButton = (
    <button onClick={toggleRailExpanded} aria-label={railExpanded ? 'Collapse sidebar' : 'Expand sidebar'} className={railButtonClass}>
      {railExpanded ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      {railExpanded && <span className="text-[12.5px] font-medium">Collapse sidebar</span>}
    </button>
  )

  // Only meaningful while a worktree is open — nothing to "go back" to otherwise.
  const backButton = wtId ? (
    <button onClick={goBack} aria-label="Back to worktrees" className={railButtonClass}>
      <ArrowLeft size={16} />
      {railExpanded && <span className="text-[12.5px] font-medium">Back to worktrees</span>}
    </button>
  ) : null

  return (
    <>
      {mobileDrawer && sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-[rgba(6,7,9,0.55)] md:hidden"
        />
      )}
      <aside
        className={cn(
          'flex flex-none flex-col border-r border-loom-border bg-loom-surface py-2',
          railExpanded ? 'w-[298px] items-stretch gap-1 px-2' : 'w-11 items-center gap-1',
          mobileDrawer &&
            cn(
              'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-[45] max-md:max-w-[86vw]',
              'max-md:shadow-[8px_0_40px_rgba(0,0,0,0.55)] max-md:transition-transform max-md:duration-200',
              sidebarOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full',
            ),
        )}
      >
        {railExpanded ? toggleButton : <Tooltip label="Expand sidebar" side="right">{toggleButton}</Tooltip>}
        {backButton && (railExpanded ? backButton : <Tooltip label="Back to worktrees" side="right">{backButton}</Tooltip>)}
        <WorkspaceSwitcher compact={!railExpanded} />
        <SidebarNav compact={!railExpanded} />
        {railExpanded && <SidebarBody />}
      </aside>
    </>
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
