import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Home, Maximize2, Minimize2, MoreHorizontal, Plus, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { cn } from '@/lib/utils'

/** The 28px toolbar buttons are fine under a mouse but far too small to hit
 *  reliably with a thumb, so they grow to 36px on touch pointers only. */
const toolbarButtonClass = 'pointer-coarse:h-9 pointer-coarse:w-9'

export interface BrowserToolbarProps {
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  loading: boolean
  hasUrl: boolean
  onReload: () => void
  onStop: () => void
  onHome: () => void
  onOpenFind: () => void
  onNewTab: () => void
  fullscreen: boolean
  onToggleFullscreen: () => void
  /** `BrowserOmnibox` — the row's centered anchor. A separate component per
   *  the one-component-per-file convention; this toolbar owns only the row
   *  shell and its two icon clusters. */
  children: ReactNode
}

/** Fixed single row, `h-9`, three zones that never move relative to each
 *  other (design spec §3.1). Back/forward are always mounted — rendering them
 *  conditionally made the first navigation shove the whole row sideways. */
export function BrowserToolbar({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  loading,
  hasUrl,
  onReload,
  onStop,
  onHome,
  onOpenFind,
  onNewTab,
  fullscreen,
  onToggleFullscreen,
  children,
}: BrowserToolbarProps) {
  // Rendered twice — inline above `@sm/tile`, inside the "…" popover below it
  // (design spec §3.1). The machine picker that used to live here now sits in
  // the omnibox, so there is nothing left that needs a compact variant.
  const rightCluster = (
    <>
      <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={onNewTab} aria-label="New tab" title="New tab (⌘T)">
        <Plus size={12} />
      </Button>
      <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={onHome} aria-label="Home">
        <Home size={12} />
      </Button>
      <Button
        size="icon-sm"
        variant="secondary"
        className={toolbarButtonClass}
        onClick={onOpenFind}
        disabled={!hasUrl}
        aria-label="Find on page"
      >
        <Search size={12} />
      </Button>
      <Button
        size="icon-sm"
        variant="secondary"
        className={toolbarButtonClass}
        onClick={onToggleFullscreen}
        aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
      >
        {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
      </Button>
    </>
  )

  return (
    <div className="flex h-9 flex-none items-center gap-1 border-b border-devdeck-border bg-devdeck-pane px-2">
      <div className="flex flex-none items-center gap-1">
        <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={onBack} disabled={!canGoBack} aria-label="Back">
          <ArrowLeft size={12} />
        </Button>
        <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={onForward} disabled={!canGoForward} aria-label="Forward">
          <ArrowRight size={12} />
        </Button>
        <Button
          size="icon-sm"
          variant="secondary"
          className={cn(toolbarButtonClass, 'group')}
          onClick={loading ? onStop : onReload}
          disabled={!hasUrl}
          aria-label={loading ? 'Stop' : 'Reload'}
        >
          {loading ? (
            <>
              {/* Spin by default, reveal the stop affordance on hover/focus.
                  Touch pointers get `X` outright — hover is unreachable. */}
              <RefreshCw
                size={12}
                className="animate-spin [animation-duration:900ms] group-hover:hidden group-focus-visible:hidden pointer-coarse:hidden"
              />
              <X size={12} className="hidden group-hover:block group-focus-visible:block pointer-coarse:block" />
            </>
          ) : (
            <RefreshCw size={12} />
          )}
        </Button>
      </div>

      <div className="flex min-w-0 flex-1 justify-center px-2">{children}</div>

      <div className="hidden flex-none items-center gap-1 @sm/tile:flex">{rightCluster}</div>
      <div className="flex-none @sm/tile:hidden">
        <TabStripPopoverMenu
          trigger={<MoreHorizontal size={13} />}
          triggerClassName={cn(
            toolbarButtonClass,
            'flex h-7 w-7 items-center justify-center rounded-md text-devdeck-fg-2 hover:bg-devdeck-hover-wash',
          )}
          triggerTitle="More"
          triggerAriaLabel="More browser controls"
          align="end"
        >
          <div className="grid w-44 gap-1 p-1">{rightCluster}</div>
        </TabStripPopoverMenu>
      </div>
    </div>
  )
}
