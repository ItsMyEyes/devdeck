import { Menu, Search } from 'lucide-react'
import { useScope } from '@/features/useScope'
import { WEB_LEAF_ID } from '@/features/palette/WebPaletteHost'
import { useWorkspace } from '@/features/data/queries'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { ModuleView } from '@/store/types'

const VIEW_TITLE: Record<ModuleView, string> = {
  agents: 'Agents',
  ssh: 'SSH',
  machines: 'Runtimes',
  tools: 'Tools',
  memory: 'Memory',
  management: 'Agent management',
  database: 'Database',
  browser: 'Browser',
  news: 'News',
  todos: 'Todos',
  invoices: 'Invoices',
}

/** The phone's top bar, and the ONLY thing that can open the sidebar drawer
 *  below `md` on the web build.
 *
 *  `Sidebar` has always had a `mobileDrawer` mode that slides in on
 *  `sidebarOpen`, but its documented trigger was `Header`'s hamburger — and
 *  `Header`'s only render site is commented out in `routes/w.$wsId.tsx`,
 *  because the Tauri tab strip took over as the top bar. The tab strip is
 *  mounted on `isTauri` alone, so on a phone the drawer was left with nothing
 *  that could reveal it: no rail, no hamburger, no way off whatever route you
 *  landed on. This is deliberately `md:hidden` — at `md` and up the rail is
 *  laid out inline and needs no trigger. */
export function MobileTopBar() {
  const { wsId, view } = useScope()
  const workspace = useWorkspace(wsId).data
  const setSidebarOpen = useDevDeckStore((s) => s.setSidebarOpen)
  const openPalette = useDevDeckStore((s) => s.openPalette)

  return (
    <header className="flex h-12 flex-none items-center gap-2 border-b border-devdeck-border bg-devdeck-pane px-2 md:hidden">
      <button
        type="button"
        onClick={() => setSidebarOpen(true)}
        aria-label="Open navigation"
        className="flex h-10 w-10 flex-none cursor-pointer items-center justify-center rounded-control text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Menu size={18} />
      </button>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold leading-tight text-devdeck-fg">{VIEW_TITLE[view]}</div>
        {workspace ? (
          <div className="truncate font-mono text-[10px] leading-tight text-devdeck-fg-2">{workspace.name}</div>
        ) : null}
      </div>

      {/* A phone has no keyboard to press the palette's chord on, so the one
          surface that reaches every host, worktree, and page needs a button.
          The leaf id must be the one `WebPaletteHost` mounts the palette with
          — `CommandPalette` keys its open state on the wsId/leafId pair, so a
          mismatch opens nothing at all. */}
      <button
        type="button"
        onClick={() => wsId && openPalette(wsId, WEB_LEAF_ID)}
        aria-label="Search and commands"
        className="flex h-10 w-10 flex-none cursor-pointer items-center justify-center rounded-control text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Search size={17} />
      </button>
    </header>
  )
}
