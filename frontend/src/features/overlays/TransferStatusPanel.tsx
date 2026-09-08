import { useEffect } from 'react'
import { CheckCircle2, Loader2, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const AUTO_DISMISS_MS = 4000

export function TransferStatusPanel() {
  const transfers = useDevDeckStore((s) => s.transfers)
  const dismissTransfer = useDevDeckStore((s) => s.dismissTransfer)

  useEffect(() => {
    const timers = transfers
      .filter((t) => t.status === 'done')
      .map((t) => setTimeout(() => dismissTransfer(t.id), AUTO_DISMISS_MS))
    return () => timers.forEach(clearTimeout)
  }, [transfers, dismissTransfer])

  if (transfers.length === 0) return null

  return (
    // `bottom-16`, not `bottom-4`: the help "?" button (features/tour/HelpFab)
    // is a permanent h-10 fixture at `bottom-4 right-4`, so the transfer stack
    // starts one button-height clear of it and grows upward from there.
    <div className="fixed bottom-16 right-4 z-50 flex w-80 flex-col gap-1.5">
      {transfers.map((t) => {
        const percent =
          t.totalBytes > 0 ? Math.min(100, Math.round((t.loadedBytes / t.totalBytes) * 100)) : t.status === 'done' ? 100 : 0
        return (
          <div
            key={t.id}
            className="rounded-lg border border-devdeck-border-menu bg-devdeck-glass-solid p-3 text-devdeck-fg shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
          >
            <div className="mb-1.5 flex items-center gap-2">
              {t.status === 'active' && <Loader2 size={13} className="flex-none animate-spin text-devdeck-wait" />}
              {t.status === 'done' && <CheckCircle2 size={13} className="flex-none text-devdeck-run" />}
              {t.status === 'error' && <XCircle size={13} className="flex-none text-devdeck-err" />}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-devdeck-fg-2">
                {t.kind === 'upload' ? 'Uploading to' : 'Downloading'} {t.label}
              </span>
              {t.status !== 'active' && (
                <button
                  type="button"
                  onClick={() => dismissTransfer(t.id)}
                  className="flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
                >
                  <X size={11} />
                </button>
              )}
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-devdeck-border-strong">
              <div
                className={cn('h-full rounded-full transition-[width]', t.status === 'error' ? 'bg-devdeck-err' : 'bg-devdeck-wait')}
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-devdeck-fg-2">
              <span>
                {t.completedFiles}/{t.totalFiles} file{t.totalFiles === 1 ? '' : 's'}
              </span>
              <span>{t.error ?? `${percent}%`}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
