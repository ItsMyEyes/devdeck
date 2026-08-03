import { useState } from 'react'
import { Check, CircleDashed, Download, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useInstallLspDep, useLspDeps } from '@/features/data/queries'
import type { DependencyStatus, LanguageDependencies } from '@/lib/machineApi'
import { cn } from '@/lib/utils'
import type { Machine } from '@/store/types'

/**
 * Shows which language servers and toolchains exist on a runtime, and installs
 * the missing ones.
 *
 * The prerequisite column is the point of the design, not decoration. A
 * language server whose toolchain is unreachable does not fail loudly — gopls
 * without a usable `go` degrades to loading each file as a standalone package,
 * which surfaces as "undefined" for every symbol in a sibling file rather than
 * as anything resembling a missing dependency. Listing the server and its
 * prerequisite side by side, with the PATH the server is actually spawned
 * with, makes that state visible instead of mysterious.
 */
export function DependenciesDialog({
  open,
  onOpenChange,
  machine,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  machine: Machine
}) {
  const deps = useLspDeps(machine, open)
  const install = useInstallLspDep(machine)
  const [installing, setInstalling] = useState<string | null>(null)

  function runInstall(binary: string, label: string) {
    setInstalling(binary)
    install.mutate(binary, {
      onSuccess: () => toast.success(`${label} language server installed`),
      onError: (error: unknown) =>
        toast.error(error instanceof Error ? error.message : `Could not install ${label}`),
      onSettled: () => setInstalling(null),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={620} z={70}>
      <div className="mb-1 flex items-center justify-between gap-3">
        <DialogTitle>Editor dependencies</DialogTitle>
        <button
          type="button"
          onClick={() => void deps.refetch()}
          disabled={deps.isFetching}
          aria-label="Re-check dependencies"
          title="Re-check dependencies"
          className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md text-devdeck-dim hover:bg-devdeck-surface-2 hover:text-devdeck-fg disabled:cursor-default disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <RefreshCw size={13} className={cn(deps.isFetching && 'animate-spin')} />
        </button>
      </div>
      <DialogDescription className="mb-4 font-sans text-[12.5px] leading-[1.55] text-devdeck-muted">
        Language servers on {machine.name}. A server needs its prerequisite to work — one without the
        other loads each file on its own and reports symbols from neighbouring files as undefined.
      </DialogDescription>

      {deps.isLoading ? (
        <div className="flex items-center gap-2 py-8 font-mono text-[12px] text-devdeck-dim">
          <Loader2 size={14} className="animate-spin" />
          Probing {machine.name}…
        </div>
      ) : deps.isError ? (
        <div className="flex items-start gap-2 rounded-md border border-devdeck-red-border bg-devdeck-red-tint px-3 py-2.5 font-mono text-[11.5px] text-devdeck-red-soft">
          <TriangleAlert size={13} className="mt-0.5 flex-none" />
          <span>
            {deps.error instanceof Error ? deps.error.message : 'Could not reach this machine'}
          </span>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            {deps.data?.languages.map((language) => (
              <LanguageRow
                key={language.server.name}
                language={language}
                installing={installing === language.server.name}
                busy={installing !== null}
                onInstall={() => runInstall(language.server.name, language.label)}
              />
            ))}
          </div>

          {deps.data ? (
            <div className="mt-4 rounded-md border border-devdeck-border bg-devdeck-surface-2 px-3 py-2.5">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-devdeck-dim-2">
                Spawn PATH
              </div>
              <div className="break-all font-mono text-[10.5px] leading-[1.5] text-devdeck-muted-2">
                {deps.data.spawnPath}
              </div>
            </div>
          ) : null}
        </>
      )}

      <div className="mt-5 flex justify-end">
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </div>
    </Dialog>
  )
}

function LanguageRow({
  language,
  installing,
  busy,
  onInstall,
}: {
  language: LanguageDependencies
  installing: boolean
  busy: boolean
  onInstall: () => void
}) {
  const ready = language.server.installed && language.prerequisite.installed

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md border px-3 py-2.5',
        ready
          ? 'border-devdeck-border-card bg-devdeck-card'
          : 'border-devdeck-border bg-devdeck-surface-2',
      )}
    >
      <div className="w-[150px] flex-none truncate text-[12.5px] font-semibold text-devdeck-fg-2">
        {language.label}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <ToolLine tool={language.server} />
        <ToolLine tool={language.prerequisite} />
      </div>

      <div className="flex-none">
        {language.server.installed ? null : language.installable ? (
          <Button variant="secondary" onClick={onInstall} disabled={busy}>
            {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {installing ? 'Installing…' : 'Install'}
          </Button>
        ) : (
          <span
            title={language.blocker}
            className="block max-w-[140px] truncate font-mono text-[10.5px] text-devdeck-dim"
          >
            {language.blocker}
          </span>
        )}
      </div>
    </div>
  )
}

function ToolLine({ tool }: { tool: DependencyStatus }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10.5px]">
      {tool.installed ? (
        <Check size={11} className="flex-none text-devdeck-green-soft" />
      ) : (
        <CircleDashed size={11} className="flex-none text-devdeck-dim" />
      )}
      <span className={cn('flex-none', tool.installed ? 'text-devdeck-muted' : 'text-devdeck-dim')}>
        {tool.name}
      </span>
      {tool.installed ? (
        <>
          {tool.version ? (
            <span className="flex-none text-devdeck-muted-2">{tool.version}</span>
          ) : null}
          <span className="min-w-0 truncate text-devdeck-dim-2" title={tool.path}>
            {tool.path}
          </span>
        </>
      ) : (
        <span className="text-devdeck-dim-2">not found</span>
      )}
    </div>
  )
}
