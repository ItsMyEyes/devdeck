import { Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useHubKey } from '@/features/data/queries'
import { buildInstallCommand } from '@/features/machines/installCommand'
import type { InstallTarget } from '@/features/machines/installCommand'
import { cn } from '@/lib/utils'

const TARGETS: { value: InstallTarget; label: string }[] = [
  { value: 'curl', label: 'curl' },
  { value: 'wget', label: 'wget' },
  { value: 'powershell', label: 'PowerShell' },
]

interface RuntimeInstallCommandProps {
  /** Resolved hub base URL the runtime will register against. */
  hubUrl: string
  /** Name typed into the dialog; may be empty while the operator is still typing. */
  machineName: string
}

/** The copy-pasteable install one-liner shown in the Add-runtime dialog. Owns
 *  the target toggle, the GitHub-token field, and the hub-key fetch, so
 *  MachineDialog only has to place it. See
 *  docs/superpowers/specs/2026-07-26-runtime-install-command-design.md. */
export function RuntimeInstallCommand({ hubUrl, machineName }: RuntimeInstallCommandProps) {
  const [target, setTarget] = useState<InstallTarget>('curl')
  // Held in component state only — never sent to the server, never persisted,
  // and dropped when the dialog unmounts.
  const [githubToken, setGithubToken] = useState('')
  const hubKey = useHubKey(true)

  if (hubKey.isLoading) {
    return <p className="mb-5 font-mono text-[10.5px] text-devdeck-dim-2">Loading hub key…</p>
  }

  // A hub with no --key cannot accept self-registration at all, so there is no
  // useful command to show — explaining the fix beats printing one that 401s
  // on the target machine.
  if (hubKey.data && !hubKey.data.configured) {
    return (
      <div className="mb-5 rounded-lg border border-devdeck-border-card bg-devdeck-terminal p-3">
        <p className="mb-1 font-mono text-[11px] text-devdeck-fg">This hub has no API key</p>
        <p className="font-mono text-[10.5px] text-devdeck-dim-2">
          A runtime authenticates its self-registration with the hub&apos;s key. Restart DevDeck with{' '}
          <code>--key &lt;value&gt;</code> (or set <code>DEVDECK_KEY</code>), then reopen this dialog.
        </p>
      </div>
    )
  }

  const command = buildInstallCommand({
    target,
    hubUrl,
    hubKey: hubKey.data?.key ?? '',
    machineName,
    githubToken,
  })

  function copyCommand() {
    void navigator.clipboard.writeText(command)
    toast.success('Command copied')
  }

  return (
    <>
      <Label>Target</Label>
      <div className="mb-3 flex gap-1.5">
        {TARGETS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTarget(t.value)}
            className={cn(
              'cursor-pointer rounded-md border px-2.5 py-1 font-mono text-[10.5px]',
              target === t.value
                ? 'border-devdeck-accent-soft text-devdeck-accent-soft'
                : 'border-devdeck-border-card text-devdeck-muted-2 hover:text-devdeck-fg',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Label>GitHub token (optional)</Label>
      <p className="mb-2 font-mono text-[10.5px] text-devdeck-dim-2">
        The release repo is private, so the installer needs one. Used only to build the command below — it is never
        sent to this server or saved.
      </p>
      <Input
        value={githubToken}
        type="password"
        onChange={(e) => setGithubToken(e.target.value)}
        placeholder="ghp_…"
        className="mb-3 font-mono"
      />

      <Label>Install command</Label>
      <p className="mb-2 font-mono text-[10.5px] text-devdeck-dim-2">
        Run this on the target machine. It downloads DevDeck, registers it with this hub, and verifies the
        registration landed.
      </p>
      {hubKey.isError ? (
        <p className="mb-2 font-mono text-[10.5px] text-devdeck-red-soft">
          Could not load the hub key — fill in &lt;your-hub-key&gt; yourself before running this.
        </p>
      ) : null}
      <div className="relative mb-5 rounded-lg border border-devdeck-border-card bg-devdeck-terminal p-2.5 pr-9">
        <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-devdeck-fg">{command}</pre>
        <button
          type="button"
          onClick={copyCommand}
          aria-label="Copy command"
          className="absolute right-2.5 top-2.5 cursor-pointer p-1 text-devdeck-muted-2 hover:text-devdeck-accent-soft"
        >
          <Copy size={12} />
        </button>
      </div>
    </>
  )
}
