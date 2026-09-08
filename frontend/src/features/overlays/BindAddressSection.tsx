import { Copy, Loader2, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type { BindConfig } from '@/features/desktop/desktopBridge'
import { getBindConfig, setBindConfig } from '@/features/desktop/desktopBridge'
import { useIsTauri } from '@/features/tabs/useIsTauri'
import { cn } from '@/lib/utils'

const LOOPBACK = '127.0.0.1'
const ALL_INTERFACES = '0.0.0.0'

/** Sentinel for the Select entry that reveals the free-text field, so an
 *  address the interface scan misses (a VPN, a secondary subnet, an alias)
 *  is still reachable. Not a valid IP, so it can never be saved by accident. */
const CUSTOM = 'custom'

type Mode = 'loopback' | 'all' | 'specific'

function modeOf(host: string): Mode {
  if (host === ALL_INTERFACES) return 'all'
  if (host === LOOPBACK) return 'loopback'
  return 'specific'
}

const MODE_ROWS: { mode: Mode; title: string; hint: string; note: string }[] = [
  {
    mode: 'loopback',
    title: 'Loopback only',
    hint: LOOPBACK,
    note: 'Reachable only from this device. The default.',
  },
  {
    mode: 'all',
    title: 'All interfaces',
    hint: ALL_INTERFACES,
    note: 'Reachable from every network this device is on.',
  },
  {
    mode: 'specific',
    title: 'Specific address',
    hint: 'pick one',
    note: 'Reachable only on the interface you choose.',
  },
]

function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        'mt-0.5 flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full border transition-colors',
        checked ? 'border-devdeck-accent' : 'border-devdeck-border',
      )}
    >
      {checked ? <span className="h-1.5 w-1.5 rounded-full bg-devdeck-accent" /> : null}
    </span>
  )
}

/**
 * Bind-address control for this device's hub and background runtime.
 *
 * The desktop shell hard-coded `127.0.0.1` for both, so a locally hosted hub
 * could only ever be reached through `tailscale serve` — and when that failed
 * there was no second option, only a "Restart DevDeck to expose this hub"
 * prompt that a restart could not fix. Applying a change restarts the app
 * (Rust's `set_bind_config`): `--addr` is a launch flag, so the sidecars have
 * to be respawned to pick it up.
 */
export function BindAddressSection() {
  const isTauri = useIsTauri()
  const [config, setConfig] = useState<BindConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('loopback')
  const [specific, setSpecific] = useState('')
  const [custom, setCustom] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isTauri) return
    let cancelled = false
    getBindConfig()
      .then((c) => {
        if (cancelled) return
        setConfig(c)
        setError(null)
        const m = modeOf(c.host)
        setMode(m)
        if (m === 'specific') {
          setSpecific(c.host)
          setCustom(!c.interfaces.some((i) => i.ip === c.host))
        } else {
          setSpecific(c.interfaces[0]?.ip ?? '')
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to read bind address')
      })
    return () => {
      cancelled = true
    }
  }, [isTauri])

  if (!isTauri) {
    return (
      <p className="font-mono text-[11px] text-devdeck-fg-2">
        Unavailable - this setting belongs to the device hosting the hub, so open it from the desktop app there.
      </p>
    )
  }

  if (error) {
    return (
      <p className="font-mono text-[11px] text-devdeck-err">{error}</p>
    )
  }

  if (!config) {
    return (
      <p className="inline-flex items-center gap-2 font-mono text-[11px] text-devdeck-fg-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        Reading bind address…
      </p>
    )
  }

  const chosen = mode === 'loopback' ? LOOPBACK : mode === 'all' ? ALL_INTERFACES : specific.trim()
  const dirty = chosen !== config.host
  // Mirrors Rust's bindconfig::validate — a hostname reaching `--addr` is a
  // fatal bind on the Go side, which would take the respawn loop with it.
  const valid = /^[0-9.]+$/.test(chosen)
    ? chosen.split('.').length === 4 && chosen.split('.').every((p) => p !== '' && Number(p) <= 255)
    : chosen.includes(':')

  // What to actually hand another device. `0.0.0.0` is not dialable, so it
  // resolves to a concrete interface; loopback has nothing to hand out.
  const reachableIp =
    mode === 'loopback' ? null : mode === 'all' ? (config.interfaces[0]?.ip ?? null) : chosen
  // This page is served BY the hub being described, so its own port is the
  // authoritative one. `hubPort` is only the port the shell asks for — it
  // falls back to an OS-assigned one whenever something already holds 8989
  // (a second DevDeck, a `make dev` hub), and showing the preferred port then
  // hands out a URL that connects to the wrong process or nothing at all.
  // `hubPort` is the port the hub is bound to right now, read from the
  // process itself — not the 8989 it merely prefers, which is wrong whenever
  // something else already held that port.
  const reachableUrl = reachableIp && valid ? `http://${reachableIp}:${config.hubPort}` : null

  const options = [
    ...config.interfaces.map((i) => ({ value: i.ip, label: `${i.ip} — ${i.name}` })),
    { value: CUSTOM, label: 'Other… (type an address)' },
  ]

  function apply() {
    if (!valid || saving) return
    setSaving(true)
    // Resolves only if the restart never happens — on success the app is
    // already going away, so there is no success path to render.
    setBindConfig(chosen).catch((e) => {
      setSaving(false)
      toast.error(e instanceof Error ? e.message : 'Failed to save bind address')
    })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-devdeck-border bg-devdeck-pane p-1">
        {MODE_ROWS.map((row) => {
          const active = mode === row.mode
          return (
            <button
              key={row.mode}
              type="button"
              onClick={() => setMode(row.mode)}
              disabled={saving}
              className={cn(
                'flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                active ? 'bg-devdeck-card-wash' : 'hover:bg-devdeck-card-wash/50',
                saving && 'cursor-not-allowed opacity-50',
              )}
            >
              <RadioDot checked={active} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="text-[12px] font-semibold text-devdeck-fg">{row.title}</span>
                  <span className="font-mono text-[10.5px] text-devdeck-fg-2">{row.hint}</span>
                </span>
                <span className="mt-0.5 block text-[11px] text-devdeck-fg-2">{row.note}</span>
              </span>
            </button>
          )
        })}
      </div>

      {mode === 'specific' ? (
        <div className="space-y-2">
          {config.interfaces.length === 0 && !custom ? (
            <p className="font-mono text-[11px] text-devdeck-fg-2">
              No non-loopback addresses found on this device - type one below.
            </p>
          ) : null}
          {config.interfaces.length > 0 ? (
            <Select
              value={custom ? CUSTOM : specific}
              onValueChange={(v) => {
                if (v === CUSTOM) {
                  setCustom(true)
                  return
                }
                setCustom(false)
                setSpecific(v)
              }}
              options={options}
              disabled={saving}
              aria-label="Interface address"
            />
          ) : null}
          {custom || config.interfaces.length === 0 ? (
            <Input
              value={specific}
              onChange={(e) => setSpecific(e.target.value)}
              placeholder="192.168.1.24"
              spellCheck={false}
              disabled={saving}
              className="font-mono text-[12px]"
              aria-label="Custom bind address"
            />
          ) : null}
          {chosen.length > 0 && !valid ? (
            <p className="font-mono text-[11px] text-devdeck-err">
              Not an IP address. Use one of this device's addresses - a hostname cannot be bound.
            </p>
          ) : null}
        </div>
      ) : null}

      {reachableUrl ? (
        <div className="rounded-lg border border-devdeck-border bg-devdeck-pane px-3.5 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
              {dirty ? 'Will be reachable at' : 'Hub reachable at'}
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-[11px] text-devdeck-fg">{reachableUrl}</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(reachableUrl)
                  toast.success('Copied')
                }}
                className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-card-wash text-devdeck-fg-2 hover:bg-devdeck-glass-solid hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-label="Copy hub URL"
              >
                <Copy className="h-3 w-3" />
              </button>
            </span>
          </div>
          {mode === 'all' && config.interfaces.length > 1 ? (
            <p className="mt-2 text-[11px] text-devdeck-fg-2">
              Also on {config.interfaces.slice(1).map((i) => i.ip).join(', ')}.
            </p>
          ) : null}
          {!config.portIsPreferred ? (
            <p className="mt-2 text-[11px] text-devdeck-fg-2">
              Port {config.hubPort} was assigned by the OS because something else already holds DevDeck&apos;s usual
              one - a second DevDeck, or a <span className="font-mono">make dev</span> hub. Quit that one and restart
              to get a port that stays the same.
            </p>
          ) : null}
          {dirty ? (
            <p className="mt-2 text-[11px] text-devdeck-fg-2">
              This is the current address; the port can change when DevDeck restarts.
            </p>
          ) : null}
        </div>
      ) : null}

      {mode !== 'loopback' ? (
        <div className="flex items-start gap-2 rounded-lg border border-devdeck-border bg-devdeck-pane px-3.5 py-3">
          <TriangleAlert size={14} className="mt-0.5 flex-none text-devdeck-wait" />
          <p className="text-[11px] text-devdeck-fg-2">
            Anyone who can reach this address and has the hub key gets full access, over plaintext HTTP - the desktop
            hub runs without TLS or 2FA. Expose it only on networks you trust.
          </p>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-devdeck-fg-2">
          {dirty ? 'DevDeck restarts to apply this.' : 'Currently bound to this address.'}
        </p>
        <Button onClick={apply} disabled={!dirty || !valid || saving} className="flex-none">
          {saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
          {saving ? 'Restarting…' : 'Apply & restart'}
        </Button>
      </div>
    </div>
  )
}
