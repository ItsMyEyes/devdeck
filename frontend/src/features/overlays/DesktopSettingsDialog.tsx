import { Copy, Eye, EyeOff, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { StatusDot } from '@/components/ui/status-dot'
import { changeHub, openLogFile } from '@/features/desktop/desktopBridge'
import { useMachines, useTailscaleStatus } from '@/features/data/queries'
import type { TailscaleHubStatus } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { VersionSection } from './VersionSection'

const MASKED_KEY = '••••••••••••••••'

function tailscaleLabel(status: TailscaleHubStatus | undefined, isLoading: boolean): { color: string; text: string } {
  if (isLoading || !status) return { color: '#6b7280', text: 'checking…' }
  if (status.ready) return { color: '#56d58a', text: status.url ?? 'ready' }
  if (status.reason === 'not_installed') return { color: '#f87171', text: "Tailscale isn't installed" }
  if (status.reason === 'not_ready') return { color: '#f87171', text: "Tailscale isn't signed in" }
  return { color: '#f87171', text: 'Restart DevDeck to expose this hub' }
}

export function DesktopSettingsDialog() {
  const open = useDevDeckStore((s) => s.desktopSettingsOpen)
  const close = useDevDeckStore((s) => s.closeDesktopSettings)
  const showToast = useDevDeckStore((s) => s.showToast)
  const hubApiKey = useDevDeckStore((s) => s.hubApiKey)
  const tailscaleStatus = useTailscaleStatus(open)
  const machines = useMachines()
  const localMachineId = machines.data?.find((m) => m.isLocal)?.id
  const [confirmingSwitch, setConfirmingSwitch] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [keyRevealed, setKeyRevealed] = useState(false)

  function closeDialog() {
    setConfirmingSwitch(false)
    setKeyRevealed(false)
    close()
  }

  function copyHubKey() {
    if (!hubApiKey) return
    void navigator.clipboard.writeText(hubApiKey)
    toast.success('Copied')
  }

  function restartToPicker() {
    setSwitching(true)
    changeHub().catch((err) => {
      setSwitching(false)
      showToast(err instanceof Error ? err.message : 'Failed to switch hub mode')
    })
  }

  function onOpenLog() {
    openLogFile().catch((err) => showToast(err instanceof Error ? err.message : 'Failed to open log file'))
  }

  const label = tailscaleLabel(tailscaleStatus.data, tailscaleStatus.isLoading)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !switching && closeDialog()} width={440}>
      <DialogTitle>Desktop settings</DialogTitle>
      <DialogDescription className="mb-5">This device is hosting the hub locally.</DialogDescription>

      <VersionSection machineId={localMachineId} />

      <div className="mb-5">
        <div className="mb-1.5 text-[12.5px] font-semibold text-devdeck-fg-2">Hub mode</div>
        {confirmingSwitch ? (
          <div className="rounded-lg border border-devdeck-border-card bg-devdeck-terminal p-3">
            <div className="mb-2 flex items-center gap-2">
              <TriangleAlert size={14} className="text-devdeck-yellow-soft" />
              <span className="font-mono text-[11px] text-devdeck-fg">DevDeck will restart immediately.</span>
            </div>
            <p className="mb-3 font-mono text-[10.5px] text-devdeck-dim-2">
              You&apos;ll be dropped back on the first-run hub picker. Any local sidecar this device is running
              stops too.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmingSwitch(false)} disabled={switching}>
                Cancel
              </Button>
              <Button variant="warning" size="sm" onClick={restartToPicker} disabled={switching}>
                Restart now
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-2 font-mono text-[11px] text-devdeck-dim-2">Hosting this hub locally on this device.</p>
            <Button variant="secondary" size="sm" onClick={() => setConfirmingSwitch(true)}>
              Switch to a remote hub…
            </Button>
          </>
        )}
      </div>

      <div className="mb-5">
        <div className="mb-1.5 text-[12.5px] font-semibold text-devdeck-fg-2">Hub key</div>
        <p className="mb-2 font-mono text-[11px] text-devdeck-dim-2">
          Used to self-register a new runtime with this hub — regenerates every restart.
        </p>
        {hubApiKey ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-md border border-devdeck-border-card bg-devdeck-terminal px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg">
              {keyRevealed ? hubApiKey : MASKED_KEY}
            </span>
            <button
              type="button"
              aria-label={keyRevealed ? 'Hide hub key' : 'Show hub key'}
              onClick={() => setKeyRevealed((r) => !r)}
              className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {keyRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button
              type="button"
              aria-label="Copy hub key"
              onClick={copyHubKey}
              className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Copy size={13} />
            </button>
          </div>
        ) : (
          <p className="font-mono text-[11px] text-devdeck-dim-2">Unavailable — reopen from the desktop app.</p>
        )}
      </div>

      <div className="mb-5">
        <div className="mb-1.5 text-[12.5px] font-semibold text-devdeck-fg-2">Tailscale</div>
        <span className="inline-flex items-center gap-2 font-mono text-[11px]" style={{ color: label.color }}>
          <StatusDot color={label.color} size={6} />
          {label.text}
        </span>
      </div>

      <div>
        <div className="mb-1.5 text-[12.5px] font-semibold text-devdeck-fg-2">Sidecar log</div>
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-[11px] text-devdeck-dim-2">sidecar.log for this device&apos;s local hub process.</p>
          <Button variant="secondary" size="sm" onClick={onOpenLog}>
            Open
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
