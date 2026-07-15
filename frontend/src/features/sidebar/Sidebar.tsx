import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useLoomStore } from '@/store/useLoomStore'
import { Tooltip } from '@/components/ui/tooltip'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { SidebarNav } from './SidebarNav'
import { ProjectTree } from './ProjectTree'
import { SSHGroupTree } from './SSHGroupTree'

interface SidebarProps {
  /** Whether mobile shows the sidebar as a Header-hamburger-triggered overlay drawer
   *  (hidden until `sidebarOpen`). False in workspace mode, which hides the Header
   *  entirely — there the rail has no other way to be revealed, so it stays
   *  permanently visible on mobile too, same as desktop. */
  mobileDrawer?: boolean
}

/** Left sidebar: a compact agent rail, with an expanded groups panel for agents. */
export function Sidebar({ mobileDrawer = true }: SidebarProps = {}) {
  const sidebarOpen = useLoomStore((s) => s.sidebarOpen)
  const setSidebarOpen = useLoomStore((s) => s.setSidebarOpen)
  const railExpanded = useLoomStore((s) => s.railExpanded)
  const toggleRailExpanded = useLoomStore((s) => s.toggleRailExpanded)
  const { view } = useScope()
  const canExpandPanel = view === 'agents' || view === 'ssh'
  const hasSidebarPanel = canExpandPanel && railExpanded

  const railControlClass =
    'flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-[10px] text-loom-muted transition-colors hover:bg-loom-hover-wash hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

  const toggleButton = canExpandPanel ? (
    <button
      onClick={toggleRailExpanded}
      aria-label={railExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
      className={railControlClass}
    >
      {railExpanded ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
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
          'flex flex-none overflow-hidden border-r border-loom-border bg-loom-surface',
          hasSidebarPanel ? 'w-[306px]' : 'w-[56px]',
          mobileDrawer &&
            cn(
              'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-[45] max-md:max-w-[86vw]',
              'max-md:shadow-[8px_0_40px_rgba(0,0,0,0.55)] max-md:transition-transform max-md:duration-200',
              sidebarOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full',
            ),
        )}
      >
        <div className={cn('flex flex-none flex-col items-center bg-loom-surface py-2.5', hasSidebarPanel ? 'w-[56px] border-r border-loom-border' : 'w-full')}>
          {toggleButton ? (
            <div className="mb-1 flex flex-col items-center gap-1">
              {toggleButton ? (
                <Tooltip label={railExpanded ? 'Collapse sidebar' : 'Expand sidebar'} side="right">
                  {toggleButton}
                </Tooltip>
              ) : null}
            </div>
          ) : null}
          <WorkspaceSwitcher compact />
          <SidebarNav compact />
        </div>
        {hasSidebarPanel ? (
          <div className="flex min-w-0 flex-1 flex-col bg-loom-surface">
            {view === 'ssh' ? <SSHGroupTree /> : <ProjectTree />}
          </div>
        ) : null}
      </aside>
    </>
  )
}
