import { DevDeckLogo } from '@/features/branding/DevDeckLogo'
import { useScope } from '@/features/useScope'
import { useWorkspace } from '@/features/data/queries'
import { useDevDeckStore } from '@/store/useDevDeckStore'

/** Web-build top bar: brand, mobile sidebar toggle, and live agent counts.
 *  Its only render site is currently commented out in `routes/w.$wsId.tsx` —
 *  the tab strip serves as the top bar on every workspace route. */
export function Header() {
  const { wsId, view } = useScope()
  const ws = useWorkspace(wsId).data
  const setSidebarOpen = useDevDeckStore((s) => s.setSidebarOpen)

  const worktrees = ws ? ws.projects.flatMap((p) => p.worktrees) : []
  const running = worktrees.filter((w) => w.state === 'running').length
  const waiting = worktrees.filter((w) => w.state === 'waiting').length
  const errors = worktrees.filter((w) => w.state === 'error').length

  const agents = view === 'agents'

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
