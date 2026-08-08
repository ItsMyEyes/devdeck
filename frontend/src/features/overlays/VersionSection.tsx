import { Check, Copy, Loader2, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useMachineUpdateCheck, useMachineVersion } from '@/features/data/queries'

function shortDigest(sha: string): string {
  return sha.length > 20 ? `${sha.slice(0, 12)}…${sha.slice(-8)}` : sha
}

/** Build info for one machine, plus an operator-initiated update check.
 *  Rendered in DesktopSettingsDialog for the device's own local runtime. */
export function VersionSection({ machineId }: { machineId: string | undefined }) {
  const build = useMachineVersion(machineId)
  const check = useMachineUpdateCheck(machineId)
  const [copied, setCopied] = useState(false)

  function copyDigest() {
    const sha = build.data?.sha256
    if (!sha) return
    void navigator.clipboard.writeText(sha)
    setCopied(true)
    toast.success('Copied')
    setTimeout(() => setCopied(false), 1500)
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
          {check.data?.managed ? (
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
    </div>
  )
}
