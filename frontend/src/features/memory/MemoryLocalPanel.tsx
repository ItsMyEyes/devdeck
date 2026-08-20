import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Play, Square } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/status-dot'
import { cn } from '@/lib/utils'
import type { MemoryHosting } from '@/lib/api'
import { useMemoryLocalLogs, useMemoryLocalStatus, useStartMemoryLocal, useStopMemoryLocal } from './useMemory'

const INSTALL_HINT: Record<MemoryHosting, string> = {
  manual: '',
  container:
    "Neither docker nor podman was found on this machine. Install Docker Desktop, or install Podman, or switch to “This device (bare metal)” instead.",
  baremetal:
    'Neither hindsight-api nor uv (uvx) was found on this machine. Install uv (https://docs.astral.sh/uv) for a zero-setup option, or `pip install hindsight-api` yourself.',
}

/** Pulls the last meaningful line out of a raw log tail — what a "what's it
 *  doing right now" caption shows while a start is in flight. Hindsight's
 *  own stdout (or the container engine's pull progress) is unstructured
 *  text, so this is deliberately dumb: last non-blank line, nothing parsed
 *  or guessed about its meaning — better an honest raw line than a made-up
 *  "downloading model" that isn't what's actually happening. */
function lastLine(logs: string | undefined): string {
  if (!logs) return ''
  const lines = logs.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

export function MemoryLocalPanel({
  hosting,
  localPort,
  updateMemory,
}: {
  hosting: Exclude<MemoryHosting, 'manual'>
  localPort: number
  updateMemory: { mutate: (patch: { localPort?: number }) => void }
}) {
  const [showLogs, setShowLogs] = useState(false)
  const status = useMemoryLocalStatus(true)
  const start = useStartMemoryLocal()
  const stop = useStopMemoryLocal()
  const busy = start.isPending || stop.isPending
  // Fast-poll the log tail only while something is actively happening — a
  // start in flight (this can take minutes on a cold image pull / uvx
  // fetch) or the log panel is expanded. Idle otherwise so an operator who
  // never opens "Show logs" never pays for it.
  const liveLogs = useMemoryLocalLogs(start.isPending || showLogs, start.isPending ? 1200 : 3000)

  const data = status.data
  const state: 'checking' | 'unavailable' | 'running' | 'stopped' | 'never-started' = !data
    ? 'checking'
    : !data.available
      ? 'unavailable'
      : data.running
        ? 'running'
        : data.exists
          ? 'stopped'
          : 'never-started'

  const STATE_META: Record<typeof state, { color: string; label: string }> = {
    checking: { color: '#6b7280', label: 'checking…' },
    unavailable: { color: '#f87171', label: 'not available on this machine' },
    running: { color: '#56d58a', label: `running${data?.detected ? ` · ${data.detected}` : ''}` },
    stopped: { color: '#e0c05c', label: `stopped${data?.detected ? ` · ${data.detected}` : ''}` },
    'never-started': { color: '#6b7280', label: `not started yet${data?.detected ? ` · will use ${data.detected}` : ''}` },
  }
  const meta = STATE_META[state]

  const startingCaption = useMemo(() => {
    if (!start.isPending) return ''
    const line = lastLine(liveLogs.data?.logs)
    return line || (hosting === 'container' ? 'Starting container…' : 'Starting process…')
  }, [start.isPending, liveLogs.data?.logs, hosting])

  function onStart() {
    start.mutate(undefined, {
      onSuccess: (s) => {
        if (s.running) toast.success('Started')
        else toast.error('Did not reach a running state — check the logs below')
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to start'),
    })
  }
  function onStop() {
    stop.mutate(undefined, {
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to stop'),
    })
  }

  return (
    <div className="rounded-lg border border-devdeck-border bg-devdeck-pane p-3.5">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {busy ? (
              <Loader2 size={12} className="flex-none animate-spin text-devdeck-fg-2" />
            ) : (
              <StatusDot color={meta.color} className={cn(state === 'running' && 'animate-pulse')} />
            )}
            <span className="font-mono text-[11px] text-devdeck-fg">{meta.label}</span>
          </div>
          {data?.running ? (
            <Button variant="secondary" size="sm" disabled={busy} onClick={onStop} className="gap-1.5">
              {stop.isPending ? <Loader2 size={12} className="animate-spin" /> : <Square size={11} />}
              {stop.isPending ? 'Stopping…' : 'Stop'}
            </Button>
          ) : (
            <Button size="sm" disabled={busy || (data ? !data.available : false)} onClick={onStart} className="gap-1.5">
              {start.isPending ? <Loader2 size={12} className="animate-spin" /> : <Play size={11} />}
              {start.isPending ? 'Starting…' : 'Start'}
            </Button>
          )}
        </div>

        {data && !data.available && (
          <div className="flex items-start gap-2 rounded-md bg-devdeck-hover-wash px-2.5 py-2">
            <AlertTriangle size={13} className="mt-0.5 flex-none text-devdeck-yellow" />
            <p className="text-[10.5px] leading-relaxed text-devdeck-fg-2">{INSTALL_HINT[hosting]}</p>
          </div>
        )}

        {start.isPending && (
          <div className="flex items-center gap-2 rounded-md border border-devdeck-border-accent/30 bg-devdeck-accent-tint/20 px-2.5 py-2">
            <Loader2 size={12} className="flex-none animate-spin text-devdeck-accent" />
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-devdeck-fg-2">{startingCaption}</span>
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">Local port</span>
          <input
            type="number"
            defaultValue={localPort || 8888}
            onBlur={(e) => updateMemory.mutate({ localPort: Number(e.target.value) || 8888 })}
            disabled={Boolean(data?.running)}
            className="w-32 rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg disabled:opacity-60"
          />
        </label>

        <button
          type="button"
          onClick={() => setShowLogs((v) => !v)}
          className="flex items-center gap-1 self-start font-mono text-[10.5px] text-devdeck-fg-2 hover:text-devdeck-fg"
        >
          {showLogs ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {showLogs ? 'Hide logs' : 'Show logs'}
        </button>
        {showLogs && (
          <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-devdeck-card-wash p-2 font-mono text-[10px] text-devdeck-fg-2">
            {liveLogs.isPending ? 'loading…' : liveLogs.data?.logs || '(no logs yet)'}
          </pre>
        )}
      </div>
    </div>
  )
}
