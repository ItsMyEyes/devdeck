import { AlertTriangle, Loader2, TerminalSquare, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { StatusDot } from '@/components/ui/status-dot'
import { useKillTerminalSession, useTerminalSessions } from '@/features/data/queries'
import { fmtBytes, fmtTimeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Machine, TerminalSession } from '@/store/types'

/** How stale a detached session's last output (or, absent any output, its
 *  start time) must be before the row is flagged as a likely orphan. The
 *  backend's reconnect grace period is much shorter than this, so a pane
 *  that just lost its tab is never mistaken for one that should be killed. */
const STALE_MS = 5 * 60_000

function isLikelyOrphan(session: TerminalSession): boolean {
  if (session.attached) return false
  const reference = session.lastOutputAt ?? session.startedAt
  return Date.now() - new Date(reference).getTime() > STALE_MS
}

interface SessionRowProps {
  session: TerminalSession
  killing: boolean
  onKill: (id: string) => void
}

/** One session row. A primary session's Kill button opens an inline confirm
 *  step — that id backs a worktree's own agent process, which the operator
 *  may be relying on mid-task. A spawned pane kills on the first click. */
function SessionRow({ session, killing, onKill }: SessionRowProps) {
  const [confirming, setConfirming] = useState(false)
  const orphan = isLikelyOrphan(session)

  return (
    <div
      className={cn(
        'rounded-control border px-3 py-2.5',
        orphan
          ? 'border-devdeck-yellow-tint-border bg-devdeck-yellow-tint'
          : 'border-devdeck-border-card bg-devdeck-glass-solid',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {orphan ? <AlertTriangle size={12} className="flex-none text-devdeck-wait" /> : null}
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-devdeck-fg">{session.id}</span>
        <span
          className={cn(
            'flex-none rounded-md px-1.5 py-0.5 font-mono text-[9.5px]',
            session.primary ? 'bg-devdeck-accent-tint text-devdeck-accent' : 'bg-devdeck-card-wash text-devdeck-fg-2',
          )}
        >
          {session.primary ? 'primary' : 'pane'}
        </span>
        <span
          className={cn(
            'inline-flex flex-none items-center gap-1.5 font-mono text-[9.5px]',
            session.attached ? 'text-devdeck-run' : 'text-devdeck-fg-2',
          )}
        >
          <StatusDot color={session.attached ? 'var(--devdeck-green)' : 'var(--devdeck-fg-2)'} size={5} />
          {session.attached ? 'attached' : 'detached'}
        </span>
      </div>

      <div className="mt-1.5 break-all font-mono text-[10.5px] leading-[1.5] text-devdeck-fg-2">
        {session.command || '—'}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-devdeck-fg-2">
        <span>pid {session.pid}</span>
        <span>started {fmtTimeAgo(session.startedAt)}</span>
        <span className={orphan ? 'text-devdeck-wait' : undefined}>
          {session.lastOutputAt ? `output ${fmtTimeAgo(session.lastOutputAt)}` : 'no output yet'}
        </span>
        <span>{fmtBytes(session.bufferBytes)} buffered</span>
      </div>

      <div className="mt-2 flex items-center justify-end gap-2">
        {confirming ? (
          <>
            <span className="mr-auto font-mono text-[10.5px] text-devdeck-err">
              Ends this worktree's agent process.
            </span>
            <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={killing}>
              Cancel
            </Button>
            <Button variant="destructive-solid" size="sm" onClick={() => onKill(session.id)} disabled={killing}>
              {killing && <Loader2 size={12} className="animate-spin" />}
              Kill primary
            </Button>
          </>
        ) : (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => (session.primary ? setConfirming(true) : onKill(session.id))}
            disabled={killing}
            aria-label={`Kill session ${session.id}`}
          >
            {killing && <Loader2 size={12} className="animate-spin" />}
            Kill
          </Button>
        )}
      </div>
    </div>
  )
}

export interface TerminalSessionsDialogProps {
  machine: Machine
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Operator's only window onto the backend's keep-alive-forever PTY table
 * (see machineApi.ts's fetchTerminalSessions doc comment). Polls while open
 * and lets the operator kill any session — a spawned pane immediately, a
 * worktree's primary session only after an inline confirmation, since that
 * one backs the worktree's own agent process.
 */
export function TerminalSessionsDialog({ machine, open, onOpenChange }: TerminalSessionsDialogProps) {
  const sessions = useTerminalSessions(machine, open)
  const killSession = useKillTerminalSession(machine)
  const [killingId, setKillingId] = useState<string | null>(null)

  function handleKill(id: string) {
    setKillingId(id)
    killSession.mutate(id, {
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to kill session'),
      onSettled: () => setKillingId(null),
    })
  }

  const list = sessions.data ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={560}>
      <div className="mb-2.5 flex items-center gap-2.5">
        <TerminalSquare size={15} className="text-devdeck-fg-2" />
        <DialogTitle>Terminal sessions</DialogTitle>
      </div>
      <DialogDescription className="mb-4 font-sans text-[12.5px] leading-[1.55] text-devdeck-fg-2">
        Live PTY sessions on &quot;{machine.name}&quot;. A detached session with old (or no) output is likely an
        orphan left behind by a closed tab or crashed pane.
      </DialogDescription>

      {sessions.isLoading ? (
        <div className="flex items-center gap-2 py-8 font-mono text-[12px] text-devdeck-fg-2">
          <Loader2 size={14} className="animate-spin" />
          Loading sessions…
        </div>
      ) : sessions.isError ? (
        <div className="flex items-start gap-2 rounded-control border border-devdeck-red-tint-strong-border bg-devdeck-red-tint px-3 py-2.5 font-mono text-[11.5px] text-devdeck-err">
          <TriangleAlert size={13} className="mt-0.5 flex-none" />
          <span>{sessions.error instanceof Error ? sessions.error.message : 'Could not reach this machine'}</span>
        </div>
      ) : list.length === 0 ? (
        <div className="flex min-h-[100px] flex-col items-center justify-center rounded-control border border-dashed border-devdeck-border-menu bg-devdeck-glass-solid/35 px-4 text-center">
          <p className="font-mono text-[11.5px] text-devdeck-fg-2">no terminal sessions running on this machine</p>
        </div>
      ) : (
        <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
          {list.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              killing={killingId === session.id && killSession.isPending}
              onKill={handleKill}
            />
          ))}
        </div>
      )}

      <div className="mt-5 flex justify-end">
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </div>
    </Dialog>
  )
}
