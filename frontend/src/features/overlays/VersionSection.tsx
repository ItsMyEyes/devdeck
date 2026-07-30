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
    <div className="mb-5">
      <div className="mb-1.5 text-[12.5px] font-semibold text-devdeck-fg-2">Version</div>

      {build.isLoading ? (
        <p className="font-mono text-[11px] text-devdeck-dim-2">checking…</p>
      ) : build.isError || !build.data ? (
        <p className="font-mono text-[11px] text-devdeck-red-soft">Build info unavailable.</p>
      ) : (
        <>
          <p className="font-mono text-[11px] text-devdeck-fg">{build.data.version}</p>
          {build.data.sha256 ? (
            <div className="mt-1 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-devdeck-dim-2">
                {shortDigest(build.data.sha256)}
              </span>
              <button
                type="button"
                aria-label="Copy sha256"
                onClick={copyDigest}
                className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
          ) : (
            <p className="mt-1 font-mono text-[10.5px] text-devdeck-dim-2">sha256 unavailable</p>
          )}
        </>
      )}

      {check.data?.checksumVerified === 'match' ? (
        <p className="mt-1 font-mono text-[10.5px] text-devdeck-green-soft">
          ✓ matches release {check.data.current}
        </p>
      ) : null}
      {check.data?.checksumVerified === 'mismatch' ? (
        <p className="mt-1 inline-flex items-center gap-1.5 font-mono text-[10.5px] text-devdeck-red-soft">
          <ShieldAlert size={12} />
          does not match release {check.data.current}
        </p>
      ) : null}

      <div className="mt-2.5">
        {check.data?.managed ? (
          <p className="font-mono text-[10.5px] text-devdeck-dim-2">
            Supervised by the desktop app — update by installing a new desktop release.
          </p>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => void check.refetch()} disabled={check.isFetching || !machineId}>
            {check.isFetching && <Loader2 size={13} className="animate-spin" />}
            Check for updates
          </Button>
        )}
      </div>

      {check.data ? (
        <p className="mt-2 font-mono text-[10.5px] text-devdeck-dim-2">
          {check.data.error
            ? check.data.error
            : check.data.updateAvailable
              ? `${check.data.latest} available`
              : 'up to date'}
          {check.data.tokenConfigured ? '' : ' · token: not set'}
        </p>
      ) : null}
      {check.isError ? (
        <p className="mt-2 font-mono text-[10.5px] text-devdeck-red-soft">
          Couldn&apos;t reach this machine to check for updates.
        </p>
      ) : null}
    </div>
  )
}
