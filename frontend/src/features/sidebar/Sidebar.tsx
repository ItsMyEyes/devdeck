import { KeyRound, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWhoami } from '@/features/data/queries'
import { useIsTauri } from '@/features/tabs/useIsTauri'
import { useIsDesktop } from '@/features/terminal/ExpandedTerminal'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
import { useScope } from '@/features/useScope'
import { tourAnchor } from '@/features/tour/tourAnchors'
import { useDevDeckStore } from '@/store/useDevDeckStore'
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
  const sidebarOpen = useDevDeckStore((s) => s.sidebarOpen)
  const setSidebarOpen = useDevDeckStore((s) => s.setSidebarOpen)
  const railExpanded = useDevDeckStore((s) => s.railExpanded)
  const toggleRailExpanded = useDevDeckStore((s) => s.toggleRailExpanded)
  const openDesktopSettings = useDevDeckStore((s) => s.openDesktopSettings)
  const openRuntimePin = useDevDeckStore((s) => s.openRuntimePin)
  const whoami = useWhoami()
  const { view } = useScope()
  const canExpandPanel = view === 'agents' || view === 'ssh'
  const hasSidebarPanel = canExpandPanel && railExpanded
  const isLoopbackHub = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
  const showDesktopSettings = useIsTauri() && isLoopbackHub
  // A runtime's own web UI has no hub settings to show, but it does own the
  // one thing an operator needs to change there: the PIN that got them in.
  // On the hub this is absent — a runtime's PIN is set from the Runtimes page,
  // against that runtime, not this process.
  const isRuntimeUI = whoami.data?.role === 'runtime'
  const isDesktopWidth = useIsDesktop()
  // Below `md`, this becomes a fixed overlay drawer (see `mobileDrawer` prop
  // doc) that must appear above a Browser tile's native webview — see
  // useNativeOverlayBlocker's doc comment. At `md` and up it's laid out
  // inline and never needs to block anything.
  useNativeOverlayBlocker(mobileDrawer && sidebarOpen && !isDesktopWidth)
  // The drawer is the phone's ONLY navigation (there is no rail beside the
  // content and no tab strip on the web build), so it shows the full menu —
  // labelled destinations and the workspace switcher — rather than the 56px
  // icon rail, whose hover tooltips a touch screen can never reveal.
  const inMobileDrawer = mobileDrawer && !isDesktopWidth

  const railControlClass =
    'flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-control text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-devdeck-ring'
  /** Same control, labelled and thumb-sized, for the mobile drawer. */
  const drawerControlClass =
    'flex h-11 w-full cursor-pointer items-center gap-3 rounded-control px-3 text-[13px] font-medium text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-devdeck-ring'
  const railDivider = <div aria-hidden className="my-1.5 h-px w-6 flex-none bg-devdeck-border" />

  const toggleButton = canExpandPanel ? (
    <button
      {...tourAnchor('sidebar-toggle')}
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
          'flex flex-none overflow-hidden',
          inMobileDrawer && 'flex-col',
          // The sidebar is a card on the glass: glass + a light wash. The wash
          // is mechanical, not decorative — without it the card is the same
          // value as the gap around it and its rounded corners have nothing to
          // read against.
          'my-[var(--devdeck-gap)] ml-[var(--devdeck-gap)] rounded-container bg-devdeck-card-wash',
          inMobileDrawer ? 'w-[290px]' : hasSidebarPanel ? 'w-[306px]' : 'w-[56px]',
          mobileDrawer &&
            cn(
              'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-[45] max-md:max-w-[86vw]',
              // The drawer animates `transform`, and backdrop-filter on a
              // transforming element repaints every frame. Solid keeps the
              // slide at 60fps on phones.
              'max-md:m-0 max-md:rounded-none max-md:bg-devdeck-glass-solid',
              'max-md:shadow-[8px_0_40px_rgba(0,0,0,0.55)] max-md:transition-transform max-md:duration-200',
              sidebarOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full',
            ),
        )}
        style={{ backdropFilter: 'blur(20px)', marginRight: '6px' }}
      >
        {inMobileDrawer ? (
          <div className="flex min-h-0 w-full flex-1 flex-col">
            <WorkspaceSwitcher />
            <SidebarNav compact={false} />
            {canExpandPanel ? (
              <>
                <div aria-hidden className="mx-3 my-1 h-px flex-none bg-devdeck-border" />
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {view === 'ssh' ? <SSHGroupTree /> : <ProjectTree />}
                </div>
              </>
            ) : (
              <div className="flex-1" />
            )}
            {isRuntimeUI || showDesktopSettings ? (
              <div className="flex flex-none flex-col gap-1 border-t border-devdeck-border p-2">
                {isRuntimeUI ? (
                  <button type="button" onClick={() => openRuntimePin(null, whoami.data?.machineName ?? 'this runtime')} className={drawerControlClass}>
                    <KeyRound size={16} className="flex-none" />
                    Sign-in PIN
                  </button>
                ) : null}
                {showDesktopSettings ? (
                  <button type="button" onClick={openDesktopSettings} className={drawerControlClass}>
                    <Settings size={16} className="flex-none" />
                    Desktop settings
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
        <div className={cn('flex flex-none flex-col items-center py-2.5', hasSidebarPanel ? 'w-[56px]' : 'w-full')} style={{ marginRight: '10px' }}>
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
          {railDivider}
          <SidebarNav compact />
          <div className="flex-1" />
          {isRuntimeUI || showDesktopSettings ? railDivider : null}
          {isRuntimeUI ? (
            <Tooltip label="Sign-in PIN" side="right">
              <button
                type="button"
                onClick={() => openRuntimePin(null, whoami.data?.machineName ?? 'this runtime')}
                aria-label="Sign-in PIN"
                className={railControlClass}
              >
                <KeyRound size={16} />
              </button>
            </Tooltip>
          ) : null}
          {showDesktopSettings ? (
            <Tooltip label="Desktop settings" side="right">
              <button
                {...tourAnchor('desktop-settings')}
                type="button"
                onClick={openDesktopSettings}
                aria-label="Desktop settings"
                className={railControlClass}
              >
                <Settings size={16} />
              </button>
            </Tooltip>
          ) : null}
        </div>
        )}
        {!inMobileDrawer && hasSidebarPanel ? (
          <div className="flex min-w-0 flex-1 flex-col">
            {view === 'ssh' ? <SSHGroupTree /> : <ProjectTree />}
          </div>
        ) : null}
      </aside>
    </>
  )
}
