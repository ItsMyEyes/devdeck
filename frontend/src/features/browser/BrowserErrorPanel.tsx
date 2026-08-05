import { RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { BrowserLoadError } from './browserLoadError'

/** The failed-load panel both Browser surfaces put in place of the page.
 *
 *  Shared on purpose, unlike the two surfaces' toolbars: a failed load has no
 *  surface-specific chrome to respect, and letting the copy drift between the
 *  web module and the desktop tile would mean the same timeout reads as two
 *  different problems. `className` covers the one real difference — the tile
 *  overlays the rect its native webview was occupying, the module fills its
 *  own rounded frame slot. */
export function BrowserErrorPanel({
  error,
  url,
  onRetry,
  className,
}: {
  error: BrowserLoadError
  url?: string | null
  onRetry: () => void
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-3 overflow-auto bg-devdeck-surface p-6 text-center',
        className,
      )}
    >
      <TriangleAlert size={22} className="flex-none text-devdeck-red-soft" />
      <div className="text-[13px] font-medium text-devdeck-fg">{error.title}</div>
      <p className="max-w-[420px] text-[12px] leading-relaxed text-devdeck-muted">{error.detail}</p>
      {url ? (
        <div className="max-w-full truncate font-mono text-[11px] text-devdeck-dim" title={url}>
          {url}
        </div>
      ) : null}
      <Button size="sm" variant="secondary" onClick={onRetry} className="mt-1 pointer-coarse:h-9">
        <RefreshCw size={13} />
        Retry
      </Button>
    </div>
  )
}
