import { CloudOff } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** API-down / fetch-failure state. */
export function DataError({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : undefined
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3.5 rounded-container border border-dashed border-devdeck-border-strong font-mono text-[13px] text-devdeck-fg-2">
        <CloudOff size={26} strokeWidth={1.5} className="text-devdeck-red" />
        <span>Couldn&rsquo;t reach the backend</span>
        {message ? (
          <span className="max-w-[80%] truncate text-[12px] text-devdeck-fg-2">{message}</span>
        ) : null}
        {onRetry ? (
          <Button onClick={onRetry} className="px-3.5">Retry</Button>
        ) : null}
      </div>
    </div>
  )
}
