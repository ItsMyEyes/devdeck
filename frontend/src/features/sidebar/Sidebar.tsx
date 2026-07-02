import { fmtRupiah } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useWorkspace } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { SidebarNav } from './SidebarNav'
import { ProjectTree } from './ProjectTree'

export function Sidebar() {
  const sidebarOpen = useLoomStore((s) => s.sidebarOpen)
  const setSidebarOpen = useLoomStore((s) => s.setSidebarOpen)

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

function SidebarBody() {
  const { view } = useScope()
  if (view === 'agents') return <ProjectTree />
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
