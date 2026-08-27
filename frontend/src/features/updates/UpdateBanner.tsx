// The bottom-right update pill — the UI half of
// `docs/superpowers/specs/2026-08-24-desktop-auto-update-design.md`.
//
// It renders ONLY once an update is downloaded and staged. Never while
// checking, never while downloading: those both happen on launch, and a pill
// that appeared for them would flash on every single start.
import { useState } from 'react'
import { CircleArrowUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useMachineBusy, useMachines } from '@/features/data/queries'
import { useDesktopUpdate } from '@/features/updates/useDesktopUpdate'
import { readDismissedVersion, writeDismissedVersion } from '@/features/updates/updateDismissal'

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

export function UpdateBanner() {
  const { staged, installing, install } = useDesktopUpdate()
  const machines = useMachines()
  const localMachineId = machines.data?.find((m) => m.isLocal)?.id
  // Only asked once something is actually staged: with no update to install,
  // "how much would a restart destroy" is a question nobody is asking.
  const busy = useMachineBusy(staged ? localMachineId : undefined)
  const [dismissed, setDismissed] = useState(readDismissedVersion)
  const [confirming, setConfirming] = useState(false)

  if (!staged || dismissed === staged.version) return null

  // `busy.data` absent means the advisory query failed or has not landed. The
  // pill renders and installs regardless — a broken `/busy` must never be able
  // to hold back an update (spec, Error handling).
  const counts = busy.data
  const terminals = counts?.terminals ?? 0
  const agentRuns = counts?.agentRuns ?? 0

  const parts: string[] = []
  if (terminals > 0) parts.push(plural(terminals, 'terminal'))
  if (agentRuns > 0) parts.push(`${agentRuns} agent${agentRuns === 1 ? '' : 's'} running`)
  const countsLabel = counts ? (parts.length > 0 ? parts.join(' · ') : 'Nothing running') : null

  const lossParts: string[] = []
  if (terminals > 0) lossParts.push(plural(terminals, 'terminal'))
  if (agentRuns > 0) lossParts.push(plural(agentRuns, 'agent run'))
  // Confirm when something is live — and ALSO when we simply do not know.
  // "No counts" is not evidence that nothing is running; it is the absence of
  // evidence either way, and treating it as "nothing running" is what would
  // let a silent restart kill a live agent run. The install still proceeds on
  // confirm, so a broken `/busy` never blocks an update (spec, Error
  // handling) — it only costs a click.
  const needsConfirm = !counts || lossParts.length > 0

  function onInstallClick() {
    if (needsConfirm) {
      setConfirming(true)
      return
    }
    void install()
  }

  function onLater() {
    if (!staged) return
    writeDismissedVersion(staged.version)
    setDismissed(staged.version)
  }

  return (
    // `bottom-24`, not `bottom-4`: TransferStatusPanel owns `bottom-4 right-4
    // z-50` and its cards grow upward from there, so the pill is parked one
    // card-height clear of that band instead of landing on top of it.
    <div className="fixed bottom-24 right-4 z-50 w-80">
      <div className="rounded-lg border border-devdeck-border-accent bg-devdeck-glass-solid p-3 text-devdeck-fg shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
        <div className="flex items-center gap-2">
          <CircleArrowUp size={13} className="flex-none text-devdeck-accent" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-devdeck-fg">
            v{staged.version} ready to install
          </span>
        </div>
        {countsLabel ? (
          <div className="mt-1 pl-[21px] font-mono text-[10px] text-devdeck-fg-2">{countsLabel}</div>
        ) : null}
        <div className="mt-2.5 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onLater}>
            Later
          </Button>
          <Button size="sm" disabled={installing} onClick={onInstallClick}>
            {installing ? 'Installing…' : 'Restart & install'}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Restart to install this update?"
        description={
          lossParts.length > 0 ? (
            <>
              {lossParts.join(' and ')} on this machine will be killed. DevDeck never reaps detached terminals, so
              anything still running is lost for good — the desktop app restarts the runtime with it.
            </>
          ) : (
            <>
              DevDeck couldn&apos;t check what&apos;s running on this machine, so it can&apos;t tell you what this
              will cost. Restarting kills every terminal and every in-flight agent run on it, and none of them come
              back.
            </>
          )
        }
        confirmLabel="Restart & install anyway"
        pendingLabel="Installing…"
        pending={installing}
        onOpenChange={setConfirming}
        onConfirm={() => {
          setConfirming(false)
          void install()
        }}
      />
    </div>
  )
}
