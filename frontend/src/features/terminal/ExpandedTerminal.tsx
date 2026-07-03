import { useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { STATE } from '@/lib/constants'
import { fmtCost, fmtEl, fmtTok } from '@/lib/format'
import type { Worktree } from '@/store/types'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/ui/pill'
import { StatusDot } from '@/components/ui/status-dot'
import { WorktreeGlyph } from '@/features/agents/WorktreeGlyph'
import { useUpdateWorktree } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'
import { MobileKeyToolbar } from './MobileKeyToolbar'
import { Terminal, type TerminalHandle } from './Terminal'

interface Props {
  worktree: Worktree
  wsId: string
  projectId: string
}

export function ExpandedTerminal({ worktree: w, wsId, projectId }: Props) {
  const navigate = useNavigate()
  const termRef = useRef<TerminalHandle>(null)
  const [ctrlArmed, setCtrlArmed] = useState(false)

  const openEdit = useLoomStore((s) => s.openEdit)
  const updateWorktree = useUpdateWorktree()
  const askDelete = useLoomStore((s) => s.askDelete)

  function sendKey(data: string) {
    termRef.current?.sendInput(data)
    termRef.current?.focus()
  }

  function approve(ok: boolean) {
    updateWorktree.mutate({
      id: w.id,
      patch: ok
        ? { state: 'running', pending: null, appendLine: { k: 'ok', t: '✓ approved — continuing' } }
        : { state: 'idle', pending: null, appendLine: { k: 'err', t: '✗ rejected by user — halted' } },
    })
  }
  const st = STATE[w.state]
  const label = w.root ? 'project root' : w.branch

  function back() {
    navigate({ to: '/w/$wsId/p/$projectId', params: { wsId, projectId } })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* toolbar */}
      <div className="flex min-h-[46px] flex-none flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-loom-border bg-loom-surface px-3 py-2 pl-3">
        <Button variant="secondary" onClick={back} className="pl-2">
          <ChevronLeft size={15} />
          Back
        </Button>
        <StatusDot color={st.color} pulse={w.state === 'running' || w.state === 'waiting'} />
        <WorktreeGlyph root={w.root} size={12} />
        <span className="max-w-[180px] flex-none truncate font-mono text-[13px] font-medium">{label}</span>
        <Pill color={st.color}>{st.label}</Pill>
        <span className="min-w-[90px] flex-1 truncate whitespace-nowrap font-mono text-[11px] text-loom-dim">
          {w.model} · {fmtEl(w.elapsed)} · {fmtTok(w.tokens)} tok · {fmtCost(w.tokens)}
        </span>

        <div className="flex flex-wrap items-center gap-2">
          {w.state === 'waiting' && (
            <Button variant="warning" onClick={() => approve(true)}>
              Approve
            </Button>
          )}
          <Button variant="secondary" onClick={() => openEdit('worktree', w.id, { a: w.branch, b: w.task, model: w.model })}>
            Details
          </Button>
          <Button variant="destructive" onClick={() => askDelete('worktree', w.id, label)}>
            Delete
          </Button>
        </div>
      </div>

      {/* xterm.js terminal */}
      <div className="min-h-0 flex-1 overflow-hidden bg-loom-terminal px-3 py-2">
        {/* key by session so switching worktrees mounts a fresh terminal + socket */}
        <Terminal
          key={w.id}
          ref={termRef}
          session={w.id}
          ctrlArmed={ctrlArmed}
          onCtrlConsumed={() => setCtrlArmed(false)}
        />
      </div>

      <MobileKeyToolbar ctrlArmed={ctrlArmed} onToggleCtrl={() => setCtrlArmed((a) => !a)} onSend={sendKey} />
    </div>
  )
}
