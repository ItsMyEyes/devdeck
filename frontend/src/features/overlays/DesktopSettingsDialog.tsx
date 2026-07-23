import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { StatusDot } from '@/components/ui/status-dot'
import { changeHub, openLogFile } from '@/features/desktop/desktopBridge'
import { useTailscaleStatus } from '@/features/data/queries'
import type { TailscaleHubStatus } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'

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
  const tailscaleStatus = useTailscaleStatus(open)
  const [confirmingSwitch, setConfirmingSwitch] = useState(false)
  const [switching, setSwitching] = useState(false)

  function closeDialog() {
    setConfirmingSwitch(false)
    close()
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
