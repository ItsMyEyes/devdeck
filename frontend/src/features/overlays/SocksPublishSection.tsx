import { Switch } from '@base-ui/react/switch'
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { StatusDot } from '@/components/ui/status-dot'
import {
  useLocalPublishedSocks,
  useMachines,
  usePublishedSocks,
  useSetLocalPublishedSocks,
  useSetPublishedSocks,
  useWhoami,
} from '@/features/data/queries'
import type { Machine, PublishedSOCKSStatus } from '@/store/types'
import { cn } from '@/lib/utils'

const MASKED_KEY = '••••••••••••••••'

/** The backend reads port 0 as "keep whatever this machine has stored" — sent
 *  whenever the operator has not typed a valid replacement. */
const KEEP_STORED_PORT = 0

const switchRootClass = cn(
  'relative inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full bg-devdeck-surface-2 transition-colors',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[checked]:bg-devdeck-accent',
  'disabled:cursor-not-allowed disabled:opacity-50',
)

const switchThumbClass = cn(
  'pointer-events-none block h-3.5 w-3.5 translate-x-1 rounded-full bg-devdeck-fg-2 transition-transform duration-150',
  'data-[checked]:translate-x-[18px] data-[checked]:bg-devdeck-accent-ink',
)

const iconButtonClass = cn(
  'flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted',
  'hover:bg-devdeck-popover hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-devdeck-surface-2 disabled:hover:text-devdeck-muted',
)

const fieldLabelClass = 'w-12 flex-none text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-dim-2'

/** Both row containers copy the same field, so the toast wording and the
 *  "nothing to copy" guard live in one place. */
function copySocksUrl(url: string | undefined) {
  if (!url) return
  void navigator.clipboard.writeText(url)
  toast.success('Copied')
}

interface SocksPublishRowProps {
  /** Machine label — `whoami.machineName` for the row of the process serving this page. */
  name: string
  status: PublishedSOCKSStatus | undefined
  isLoading: boolean
  error: unknown
  /** True while this row's own PUT is in flight. */
  pending: boolean
  onToggle: (enabled: boolean, port: number) => void
  onRotate: (port: number) => void
  onPortChange: (port: number) => void
  onCopy: () => void
}

/** One publish row: status, toggle, editable port, key and copy controls.
 *  Shared verbatim by the self row and every registered machine's row so the
 *  two can never drift. Purely presentational — every mutation is a callback. */
function SocksPublishRow({
  name,
  status,
  isLoading,
  error,
  pending,
  onToggle,
  onRotate,
  onPortChange,
  onCopy,
}: SocksPublishRowProps) {
  const [revealed, setRevealed] = useState(false)
  const [portDraft, setPortDraft] = useState('')

  const storedPort = status?.port ?? 0
  // Re-seed the input whenever the machine reports a different port: first
  // load, another client's edit, or a rejected change snapping back. Keyed on
  // the reported port, so a refetch that returns the same value never clobbers
  // what the operator is halfway through typing.
  useEffect(() => {
    setPortDraft(storedPort > 0 ? String(storedPort) : '')
  }, [storedPort])

  const parsedPort = Number.parseInt(portDraft, 10)
  const portValid = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
  const portInvalid = portDraft.trim() !== '' && !portValid
  // What every apply from this row sends: the typed port, or 0 for "unchanged".
  const appliedPort = portValid ? parsedPort : KEEP_STORED_PORT
  const portUnapplied = portValid && storedPort > 0 && parsedPort !== storedPort

  const enabled = status?.enabled ?? false
  const running = status?.running ?? false
  // Three states, not two: `enabled && !running` is a machine whose listener
  // failed to bind (usually the port was taken), which must not look the same
  // as one the operator deliberately turned off.
  const dotColor = running
    ? 'var(--devdeck-green)'
    : enabled
      ? 'var(--devdeck-yellow)'
      : 'var(--devdeck-dim)'

  // Enter, deliberately — not blur. A blur-commit would fire its own PUT on
  // the way to clicking the toggle, so the operator's click would land on a
  // switch already disabled by that in-flight mutation. Every other apply
  // (toggle, rotate) carries `appliedPort` anyway, so nothing is lost.
  function commitPort() {
    if (!portValid || pending || parsedPort === storedPort) return
    onPortChange(parsedPort)
  }

  return (
    <div className="rounded-lg border border-devdeck-border bg-devdeck-terminal p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot color={dotColor} size={6} />
          <span className="truncate text-[12.5px] text-devdeck-fg">{name}</span>
        </div>
        {isLoading ? (
          <span className="font-mono text-[11px] text-devdeck-dim-2">loading…</span>
        ) : error ? (
          <span className="font-mono text-[11px] text-devdeck-red-soft">
            {error instanceof Error ? error.message : 'unreachable'}
          </span>
        ) : (
          <Switch.Root
            checked={enabled}
            onCheckedChange={(next) => onToggle(next, appliedPort)}
            disabled={pending || portInvalid}
            aria-label={`Publish SOCKS5 on ${name}`}
            className={switchRootClass}
          >
            <Switch.Thumb className={switchThumbClass} />
          </Switch.Root>
        )}
      </div>

      {/* Neither loading, failed, nor answered: the fetch is gated off (the
          section is not on screen), so there is nothing to show yet. */}
      {!status && !isLoading && !error && (
        <p className="mt-3 font-mono text-[11px] text-devdeck-dim-2">Proxy status unavailable.</p>
      )}

      {status && !error && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className={fieldLabelClass}>Port</span>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={portDraft}
              onChange={(e) => setPortDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitPort()
                }
              }}
              disabled={pending}
              aria-label={`SOCKS5 port on ${name}`}
              aria-invalid={portInvalid}
              className="h-7 w-24 flex-none px-2 font-mono text-[11px]"
            />
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-mono text-[11px]',
                running ? 'text-devdeck-fg-2' : enabled ? 'text-devdeck-yellow-soft' : 'text-devdeck-dim-2',
              )}
            >
              {running
                ? (status.boundAddr ?? `:${status.port}`)
                : enabled
                  ? 'enabled, not listening — the port may be in use'
                  : 'stopped'}
            </span>
          </div>

          {portInvalid && (
            <p className="pl-[60px] font-mono text-[10.5px] text-devdeck-red-soft">
              Port must be a number between 1–65535.
            </p>
          )}
          {!portInvalid && portUnapplied && (
            <p className="pl-[60px] font-mono text-[10.5px] text-devdeck-dim-2">
              Press Enter to apply port {parsedPort}.
            </p>
          )}

          {/* Rendered whenever a key exists, not only while running: after a
              failed bind the state is enabled + not running, and that is
              exactly when the operator needs the key and a way to retry. */}
          {status.key !== '' && (
            <div className="flex items-center gap-3">
              <span className={fieldLabelClass}>Key</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-devdeck-fg">
                {revealed ? status.key : MASKED_KEY}
              </span>
              <div className="flex flex-none items-center gap-2">
                <button
                  type="button"
                  aria-label={revealed ? `Hide SOCKS5 key for ${name}` : `Show SOCKS5 key for ${name}`}
                  onClick={() => setRevealed((r) => !r)}
                  className={iconButtonClass}
                >
                  {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  type="button"
                  aria-label={`Rotate SOCKS5 key on ${name}`}
                  title={running ? 'Rotate the key' : 'Rotate the key and retry the listener'}
                  onClick={() => onRotate(appliedPort)}
                  disabled={pending}
                  className={iconButtonClass}
                >
                  <RefreshCw size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`Copy SOCKS5 URL for ${name}`}
                  title={status.url ? status.url : 'No URL until the proxy is listening'}
                  onClick={onCopy}
                  disabled={!status.url}
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

/** The row for the process serving this page. Talks to the current origin
 *  directly — there is no Machine record for it (see useLocalPublishedSocks). */
function LocalSocksRow({ name, open }: { name: string; open: boolean }) {
  const query = useLocalPublishedSocks(open)
  const setPublished = useSetLocalPublishedSocks()
  const status = query.data

  return (
    <SocksPublishRow
      name={name}
      status={status}
      isLoading={query.isLoading}
      error={query.error}
      pending={setPublished.isPending}
      onToggle={(enabled, port) => setPublished.mutate({ enabled, port })}
      onRotate={(port) => setPublished.mutate({ enabled: true, port, rotateKey: true })}
      onPortChange={(port) => setPublished.mutate({ enabled: status?.enabled ?? false, port })}
      onCopy={() => copySocksUrl(status?.url)}
    />
  )
}

/** One registered runtime's row, addressed through the hub or directly. */
function MachineSocksRow({ machine, open }: { machine: Machine; open: boolean }) {
  const query = usePublishedSocks(machine, open)
  const setPublished = useSetPublishedSocks()
  const status = query.data

  return (
    <SocksPublishRow
      name={machine.name}
      status={status}
      isLoading={query.isLoading}
      error={query.error}
      pending={setPublished.isPending}
      onToggle={(enabled, port) => setPublished.mutate({ machine, body: { enabled, port } })}
      onRotate={(port) => setPublished.mutate({ machine, body: { enabled: true, port, rotateKey: true } })}
      onPortChange={(port) =>
        setPublished.mutate({ machine, body: { enabled: status?.enabled ?? false, port } })
      }
      onCopy={() => copySocksUrl(status?.url)}
    />
  )
}

/** Settings › Network › SOCKS5 Proxy. `open` gates every fetch so the app
 *  never pulls live proxy credentials while the dialog is closed.
 *
 *  The list is the hub's registry of *remote* runtimes plus a row for this
 *  process itself: a --role hub never self-registers, so without that row the
 *  machine serving this page — the desktop app's default — would be the one
 *  machine an operator could not publish from. */
export function SocksPublishSection({ open }: { open: boolean }) {
  const machines = useMachines(open)
  const whoami = useWhoami()

  const selfName = whoami.data?.machineName || 'This machine'
  // A runtime that has self-registered IS in the list; drop it there so it
  // does not render twice. machineId is empty on a hub and on a runtime that
  // has not registered yet, which must never match a real machine's id.
  const selfId = whoami.data?.machineId ?? ''
  const others = (machines.data ?? []).filter((m) => !(selfId !== '' && m.id === selfId))

  return (
    <div className="flex flex-col gap-2.5">
      <LocalSocksRow name={selfName} open={open} />

      {machines.isLoading ? (
        <p className="font-mono text-[11px] text-devdeck-dim-2">Loading machines…</p>
      ) : machines.error ? (
        <p className="font-mono text-[11px] text-devdeck-red-soft">
          {machines.error instanceof Error ? machines.error.message : 'Failed to load machines'}
        </p>
      ) : others.length === 0 ? (
        <p className="font-mono text-[11px] text-devdeck-dim-2">
          No other machines registered yet — add one to publish a proxy from it too.
        </p>
      ) : (
        others.map((m) => <MachineSocksRow key={m.id} machine={m} open={open} />)
      )}
    </div>
  )
}
