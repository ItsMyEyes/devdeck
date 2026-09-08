import { Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { StatusDot } from '@/components/ui/status-dot'
import { Switch } from '@/components/ui/switch'
import { useSetTailscaleServe, useTailscaleStatus } from '@/features/data/queries'
import type { TailscaleHubStatus } from '@/lib/api'

/** Status dot colour + text for one Tailscale state.
 *
 *  Every reason here is distinct and actionable. The endpoint used to answer
 *  "serve_disabled" for every failure without probing Tailscale at all, so a
 *  machine with no CLI or a logged-out node was told to restart — advice that
 *  could never work. See backend/internal/handler/tailscale_status.go. */
function statusLabel(
  status: TailscaleHubStatus | undefined,
  isLoading: boolean,
): { color: string; text: string } {
  if (isLoading || !status) return { color: '#6b7280', text: 'checking…' }
  if (status.ready) return { color: '#56d58a', text: status.url ?? 'ready' }
  if (status.reason === 'not_installed')
    return { color: '#f87171', text: 'Tailscale CLI not found on this machine' }
  if (status.reason === 'not_ready') return { color: '#f87171', text: "Tailscale isn't signed in" }
  if (status.reason === 'serve_target_mismatch')
    return { color: '#f87171', text: 'tailscale serve points at a stale port' }
  return { color: '#9ca3af', text: 'not exposed on your tailnet' }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">{label}</span>
      {children}
    </div>
  )
}

/**
 * Live start/stop for this hub's `tailscale serve`, plus the port it actually
 * fronts.
 *
 * Exposure used to be decided once at launch from --enable-tailscale-serve,
 * with no way to change it afterwards. The desktop shell derives that flag
 * from a one-shot preflight that loses a race against a Tailscale daemon still
 * starting up at login, so a hub could end up permanently unexposed — and
 * every restart re-ran the same losing probe. This toggle is the way out
 * without a restart.
 */
export function TailscaleServeSection({ open }: { open: boolean }) {
  const status = useTailscaleStatus(open)
  const setServe = useSetTailscaleServe()
  const label = statusLabel(status.data, status.isLoading)

  const data = status.data
  // The serve child's port, falling back to the hub's own — they match in
  // every healthy state, and differ exactly when serve is pointed somewhere
  // stale, which is the case worth showing verbatim.
  const servePort = data?.servePort ?? data?.hubPort ?? ''
  const mismatched = data?.reason === 'serve_target_mismatch'

  return (
    <div className="rounded-lg border border-devdeck-border bg-devdeck-pane p-3.5">
      <Row label="Status">
        <span className="inline-flex min-w-0 items-center gap-2 font-mono text-[11px]" style={{ color: label.color }}>
          <StatusDot color={label.color} size={6} />
          <span className="truncate">{label.text}</span>
          {status.data?.ready && status.data.url ? (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(status.data!.url!)
                toast.success('Copied')
              }}
              className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-card-wash text-devdeck-fg-2 hover:bg-devdeck-glass-solid hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label="Copy tailnet URL"
            >
              <Copy className="h-3 w-3" />
            </button>
          ) : null}
        </span>
      </Row>

      {data?.hubPort ? (
        <>
          <div className="my-3 border-t border-devdeck-border" />
          <Row label={data.serving ? 'Serving port' : 'Hub port'}>
            <span className="font-mono text-[11px] text-devdeck-fg">
              {servePort}
              {mismatched ? (
                <span className="ml-2 text-devdeck-err">serve targets a different port</span>
              ) : null}
            </span>
          </Row>
        </>
      ) : null}

      {data?.canServe ? (
        <>
          <div className="my-3 border-t border-devdeck-border" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-devdeck-fg">Expose on tailnet</div>
              <p className="mt-0.5 text-[11px] text-devdeck-fg-2">
                Runs <span className="font-mono">tailscale serve</span> against port {data.hubPort} for as long as it
                stays on. Turning it off drops the tailnet mapping and leaves the hub serving locally.
              </p>
            </div>
            <div className="flex flex-none items-center gap-2 pt-0.5">
              {setServe.isPending ? <Loader2 className="h-3 w-3 animate-spin text-devdeck-fg-2" /> : null}
              <Switch
                checked={data.serving}
                onCheckedChange={(v) => setServe.mutate(v)}
                disabled={setServe.isPending}
                aria-label="Expose this hub on your tailnet"
              />
            </div>
          </div>
          {mismatched ? (
            <p className="mt-2 text-[11px] text-devdeck-fg-2">
              A leftover mapping is pointing at another port. Toggle this off and on to re-point it at {data.hubPort}.
            </p>
          ) : null}
        </>
      ) : null}

      {data && !data.canServe ? (
        <p className="mt-3 text-[11px] text-devdeck-fg-2">
          {data.reason === 'not_installed'
            ? "Install Tailscale, or run its “Install Tailscale command line tool” menu action — DevDeck shells out to the CLI. You can also skip Tailscale and expose the hub on your local network with the bind address above."
            : 'Sign in to Tailscale (or run `tailscale up`), then this switch becomes available.'}
        </p>
      ) : null}
    </div>
  )
}
