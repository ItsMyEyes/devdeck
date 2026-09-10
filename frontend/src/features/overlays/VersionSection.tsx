import { Check, Copy, Loader2, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useMachineBusy, useMachineUpdateCheck, useMachineVersion } from '@/features/data/queries'
import { useIsTauri } from '@/features/tabs/useIsTauri'
import { useDesktopUpdate } from '@/features/updates/useDesktopUpdate'

function shortDigest(sha: string): string {
  return sha.length > 20 ? `${sha.slice(0, 12)}…${sha.slice(-8)}` : sha
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** Build info for one machine, plus an update path.
 *  Rendered in DesktopSettingsDialog for the device's own local runtime.
 *
 *  Which update path depends on where this is running, and the split is
 *  decision D1 of `2026-08-24-desktop-auto-update-design.md`:
 *
 *  - On the web this is unchanged. `useMachineUpdateCheck` asks GitHub on an
 *    explicit click (never automatically — D9 of the 2026-07-30 spec), and a
 *    `managed` runtime still reports the dead end, because for a
 *    separately-launched runtime supervised by someone else's desktop app it
 *    remains true: `SelfHandler.PostUpdate` really does 409 there.
 *  - Inside the desktop shell that dead end is no longer true of *this*
 *    process, so it is replaced. The whole `.app`/`.exe`/`.AppImage`, sidecar
 *    included, is updated by the Tauri updater, and the same staged payload
 *    the bottom-right pill offers is installable from right here. */
export function VersionSection({ machineId }: { machineId: string | undefined }) {
  const build = useMachineVersion(machineId)
  const check = useMachineUpdateCheck(machineId)
  const [copied, setCopied] = useState(false)

  const isTauri = useIsTauri()
  // Safe to call on the web: the hook self-gates on the same Tauri test and
  // never runs a check, so `staged` stays null and this branch stays dead.
  const { staged, installing, checking, downloading, install } = useDesktopUpdate()
  const desktopStaged = isTauri ? staged : null
  // Settings is opened deliberately, unlike the always-mounted pill, so
  // surfacing the in-flight state here does not create a launch-time
  // flicker — it tells the operator something they'd otherwise have no way
  // to know: the app is checking, or is already pulling the payload down.
  const desktopStatusLabel = checking ? 'Checking for updates…' : downloading ? 'Downloading update…' : null
  // Advisory only, and only worth asking once something is actually staged —
  // with no update to install, "what would a restart destroy" is a question
  // nobody is asking.
  const busy = useMachineBusy(desktopStaged ? machineId : undefined)
  const [confirming, setConfirming] = useState(false)

  // `busy.data` absent means the query failed or has not landed yet. That must
  // never hold back an update (spec, Error handling): the counts simply go
  // unmentioned and the install proceeds.
  const counts = busy.data
  const terminals = counts?.terminals ?? 0
  const agentRuns = counts?.agentRuns ?? 0
  const parts: string[] = []
  if (terminals > 0) parts.push(plural(terminals, 'terminal'))
  if (agentRuns > 0) parts.push(`${agentRuns} agent${agentRuns === 1 ? '' : 's'} running`)
  const countsLabel = parts.length > 0 ? parts.join(' · ') : ''

  const lossParts: string[] = []
  if (terminals > 0) lossParts.push(plural(terminals, 'terminal'))
  if (agentRuns > 0) lossParts.push(plural(agentRuns, 'agent run'))
  // D2: the restart kills the sidecar, and with it every PTY and every
  // in-flight agent run on this machine. Confirm whenever we know something is
  // live — with nothing to name, a dialog would just be a second click.
  // Also confirms when the counts are simply unknown: absence of evidence is
  // not evidence that nothing is running, and treating it as "nothing" is what
  // would let a silent restart kill a live agent run. Matches UpdateBanner.
  const needsConfirm = !counts || lossParts.length > 0

  function copyDigest() {
    const sha = build.data?.sha256
    if (!sha) return
    void navigator.clipboard.writeText(sha)
    setCopied(true)
    toast.success('Copied')
    setTimeout(() => setCopied(false), 1500)
  }

  function onInstallClick() {
    if (needsConfirm) {
      setConfirming(true)
      return
    }
    void install()
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">Build</div>
          <div className="mt-1 text-[13px] font-semibold text-devdeck-fg">Version</div>
          <p className="mt-1 text-[11.5px] text-devdeck-fg-2">
            Build identity and update status for this device&apos;s local runtime.
          </p>
        </div>
        <div className="flex-none">
          {isTauri ? (
            desktopStaged ? (
              <Button size="sm" disabled={installing} onClick={onInstallClick}>
                {installing && <Loader2 size={13} className="animate-spin" />}
                {'Restart & install'}
              </Button>
            ) : desktopStatusLabel ? (
              <p className="flex max-w-[220px] items-center justify-end gap-1.5 text-right font-mono text-[10.5px] text-devdeck-fg-2">
                <Loader2 size={12} className="flex-none animate-spin" />
                {desktopStatusLabel}
              </p>
            ) : (
              <p className="max-w-[220px] text-right font-mono text-[10.5px] text-devdeck-fg-2">
                The desktop app checks for updates on its own.
              </p>
            )
          ) : check.data?.managed ? (
            <p className="max-w-[220px] text-right font-mono text-[10.5px] text-devdeck-fg-2">
              Supervised by the desktop app - update by installing a new desktop release.
            </p>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void check.refetch()}
              disabled={check.isFetching || !machineId}
            >
              {check.isFetching && <Loader2 size={13} className="animate-spin" />}
              Check for updates
            </Button>
          )}
        </div>
      </div>

      {isTauri ? (
        // "no update staged" is deliberately narrower than "up to date": a
        // silent failed check and a genuine no-op both land here, and
        // claiming the latter would be a guess. checking/downloading are
        // distinguishable from that idle state via `desktopStatusLabel`.
        <p className="mt-2.5 font-mono text-[10.5px] text-devdeck-fg-2">
          {desktopStaged
            ? `v${desktopStaged.version} ready to install${countsLabel ? ` · ${countsLabel}` : ''}`
            : desktopStatusLabel ?? 'no update staged'}
        </p>
      ) : (
        <>
          {check.data ? (
            <p className="mt-2.5 font-mono text-[10.5px] text-devdeck-fg-2">
              {check.data.error
                ? check.data.error
                : check.data.updateAvailable
                  ? `${check.data.latest} available`
                  : 'up to date'}
              {check.data.tokenConfigured ? '' : ' · token: not set'}
            </p>
          ) : null}
          {check.isError ? (
            <p className="mt-2.5 font-mono text-[10.5px] text-devdeck-err">
              Couldn&apos;t reach this machine to check for updates.
            </p>
          ) : null}
        </>
      )}

      <div className="my-4 border-t border-devdeck-border" />

      <div className="rounded-lg border border-devdeck-border bg-devdeck-pane p-3.5">
        {build.isLoading ? (
          <p className="font-mono text-[11px] text-devdeck-fg-2">checking…</p>
        ) : build.isError || !build.data ? (
          <p className="font-mono text-[11px] text-devdeck-err">Build info unavailable.</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
                Version
              </span>
              <span className="font-mono text-[11px] text-devdeck-fg">{build.data.version}</span>
            </div>

            <div className="mt-3 border-t border-devdeck-border pt-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex-none text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
                  SHA256
                </span>
                {build.data.sha256 ? (
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-[10.5px] text-devdeck-fg-2">
                      {shortDigest(build.data.sha256)}
                    </span>
                    <button
                      type="button"
                      aria-label="Copy sha256"
                      onClick={copyDigest}
                      className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-card-wash text-devdeck-fg-2 hover:bg-devdeck-glass-solid hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      {copied ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                ) : (
                  <span className="font-mono text-[10.5px] text-devdeck-fg-2">sha256 unavailable</span>
                )}
              </div>
            </div>
          </>
        )}

        {check.data?.checksumVerified === 'match' ? (
          <div className="mt-3 border-t border-devdeck-border pt-3">
            <p className="font-mono text-[10.5px] text-devdeck-run">
              ✓ matches release {check.data.current}
            </p>
          </div>
        ) : null}
        {check.data?.checksumVerified === 'mismatch' ? (
          <div className="mt-3 border-t border-devdeck-border pt-3">
            <p className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-devdeck-err">
              <ShieldAlert size={12} />
              does not match release {check.data.current}
            </p>
          </div>
        ) : null}
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
