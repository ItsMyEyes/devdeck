import { Switch } from '@base-ui/react/switch'
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { StatusDot } from '@/components/ui/status-dot'
import { useMachines, usePublishedSocks, useSetPublishedSocks } from '@/features/data/queries'
import type { Machine } from '@/store/types'
import { cn } from '@/lib/utils'

const MASKED_KEY = '••••••••••••••••'

const switchRootClass = cn(
  'relative inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full bg-devdeck-surface-2 transition-colors',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[checked]:bg-devdeck-accent',
)

const switchThumbClass = cn(
  'pointer-events-none block h-3.5 w-3.5 translate-x-1 rounded-full bg-devdeck-fg-2 transition-transform duration-150',
  'data-[checked]:translate-x-[18px] data-[checked]:bg-devdeck-accent-ink',
)

const iconButtonClass = cn(
  'flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted',
  'hover:bg-devdeck-popover hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
)

/** One machine's publish row: status, toggle, port, key, copy. */
function MachineRow({ machine, open }: { machine: Machine; open: boolean }) {
  const query = usePublishedSocks(machine, open)
  const setPublished = useSetPublishedSocks()
  const [revealed, setRevealed] = useState(false)

  const status = query.data
  const running = status?.running ?? false

  function toggle(next: boolean) {
    setPublished.mutate({ machine, body: { enabled: next } })
  }

  function rotate() {
    setPublished.mutate({ machine, body: { enabled: true, rotateKey: true } })
  }

  function copyUrl() {
    if (!status?.url) return
    void navigator.clipboard.writeText(status.url)
    toast.success('Copied')
  }

  return (
    <div className="rounded-lg border border-devdeck-border bg-devdeck-terminal p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot color={running ? '#56d58a' : '#6b7280'} size={6} />
          <span className="truncate text-[12.5px] text-devdeck-fg">{machine.name}</span>
        </div>
        {query.isLoading ? (
          <span className="font-mono text-[11px] text-devdeck-dim-2">loading…</span>
        ) : query.error ? (
          <span className="font-mono text-[11px] text-devdeck-red-soft">
            {query.error instanceof Error ? query.error.message : 'unreachable'}
          </span>
        ) : (
          <Switch.Root
            checked={status?.enabled ?? false}
            onCheckedChange={toggle}
            disabled={setPublished.isPending}
            aria-label={`Publish SOCKS5 on ${machine.name}`}
            className={switchRootClass}
          >
            <Switch.Thumb className={switchThumbClass} />
          </Switch.Root>
        )}
      </div>

      {status && !query.error && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className="w-12 flex-none text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-dim-2">
              Addr
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-devdeck-fg-2">
              {running ? (status.boundAddr ?? `:${status.port}`) : `port ${status.port} — stopped`}
            </span>
          </div>

          {running && (
            <div className="flex items-center gap-3">
              <span className="w-12 flex-none text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-dim-2">
                Key
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-devdeck-fg">
                {revealed ? status.key : MASKED_KEY}
              </span>
              <div className="flex flex-none items-center gap-2">
                <button
                  type="button"
                  aria-label={revealed ? 'Hide SOCKS5 key' : 'Show SOCKS5 key'}
                  onClick={() => setRevealed((r) => !r)}
                  className={iconButtonClass}
                >
                  {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  type="button"
                  aria-label={`Rotate SOCKS5 key on ${machine.name}`}
                  onClick={rotate}
                  className={iconButtonClass}
                >
                  <RefreshCw size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`Copy SOCKS5 URL for ${machine.name}`}
                  onClick={copyUrl}
                  className={iconButtonClass}
                >
                  <Copy size={13} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Settings › Network › SOCKS5 Proxy. `open` gates every per-machine fetch so
 *  the app never pulls live proxy credentials while the dialog is closed. */
export function SocksPublishSection({ open }: { open: boolean }) {
  const machines = useMachines(open)

  if (machines.isLoading) {
    return <p className="font-mono text-[11px] text-devdeck-dim-2">Loading machines…</p>
  }
  if (machines.error) {
    return (
      <p className="font-mono text-[11px] text-devdeck-red-soft">
        {machines.error instanceof Error ? machines.error.message : 'Failed to load machines'}
      </p>
    )
  }
  if (!machines.data?.length) {
    return (
      <p className="font-mono text-[11px] text-devdeck-dim-2">
        No machines registered yet — add one to publish a proxy from it.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      {machines.data.map((m) => (
        <MachineRow key={m.id} machine={m} open={open} />
      ))}
    </div>
  )
}
