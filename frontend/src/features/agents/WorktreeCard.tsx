import { useNavigate } from '@tanstack/react-router'
import { Maximize2 } from 'lucide-react'
import { KIND, STATE } from '@/lib/constants'
import { fmtCost, fmtEl, fmtTok } from '@/lib/format'
import type { Worktree } from '@/store/types'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/ui/pill'
import { StatusDot } from '@/components/ui/status-dot'
import { WorktreeGlyph } from './WorktreeGlyph'
import { useUpdateWorktree } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

interface WorktreeCardProps {
  worktree: Worktree
  wsId: string
  projectId: string
}

export function WorktreeCard({ worktree: w, wsId, projectId }: WorktreeCardProps) {
  const navigate = useNavigate()
  const updateWorktree = useUpdateWorktree()
  const openEdit = useLoomStore((s) => s.openEdit)
  const askDelete = useLoomStore((s) => s.askDelete)

  function approve(ok: boolean) {
    updateWorktree.mutate({
      id: w.id,
      patch: ok
        ? { state: 'running', pending: null, appendLine: { k: 'ok', t: '✓ approved — continuing' } }
        : { state: 'idle', pending: null, appendLine: { k: 'err', t: '✗ rejected by user — halted' } },
    })
  }
  function retry() {
    updateWorktree.mutate({ id: w.id, patch: { state: 'running', appendLine: { k: 'sys', t: '↻ retrying with patched config…' } } })
  }
  function pauseToggle() {
    const active = w.state === 'running' || w.state === 'waiting'
    updateWorktree.mutate({
      id: w.id,
      patch: active
        ? { state: 'stopped', pending: null, appendLine: { k: 'sys', t: '⏸ paused by user' } }
        : { state: 'running', appendLine: { k: 'sys', t: '▶ resumed' } },
    })
  }
  const st = STATE[w.state]
  const label = w.root ? 'project root' : w.branch
  const tail = w.lines.slice(-4)
  const paused = w.state === 'stopped' || w.state === 'idle'

  function expand() {
    navigate({ to: '/w/$wsId/p/$projectId/wt/$wtId', params: { wsId, projectId, wtId: w.id } })
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-[13px] border border-loom-border-card bg-loom-card">
      {/* header */}
      <div onClick={expand} className="flex cursor-pointer items-center gap-2.5 px-[13px] pb-[9px] pt-[13px]">
        <StatusDot color={st.color} pulse={w.state === 'running' || w.state === 'waiting'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate font-mono text-[12.5px] font-medium text-loom-fg">
            <WorktreeGlyph root={w.root} size={12} />
            <span className="truncate">{label}</span>
          </div>
          <div className="mt-[3px] font-mono text-[10px] text-loom-dim">
            {w.base} · +{w.added} −{w.removed} · {w.files}f · {w.model}
          </div>
        </div>
        <Pill color={st.color}>{st.label}</Pill>
      </div>

      {/* task */}
      <div className="line-clamp-2 px-[13px] pb-[11px] text-[12px] leading-[1.45] text-loom-muted">
        {w.task || <span className="italic text-loom-dim">no task — runs interactively</span>}
      </div>

      {/* needs-approval */}
      {w.state === 'waiting' && (
        <div className="mx-[11px] mb-[11px] rounded-[10px] border border-[#3a3112] bg-[#1f1a08] px-[11px] py-2.5">
          <div className="mb-2 text-[11.5px] font-medium text-loom-yellow">⚠ Needs approval</div>
          <div className="mb-2.5 font-mono text-[11.5px] leading-[1.4] text-[#d8cba0]">{w.pending}</div>
          <div className="flex gap-2">
            <Button variant="warning" className="h-[29px] flex-1" onClick={() => approve(true)}>
              Approve
            </Button>
            <Button
              variant="secondary"
              className="h-[29px] flex-1 border-[#3a3112] hover:bg-[#241d0a]"
              onClick={() => approve(false)}
            >
              Reject
            </Button>
          </div>
        </div>
      )}

      {/* error */}
      {w.state === 'error' && (
        <div className="mx-[11px] mb-[11px] flex items-center gap-2.5 rounded-[10px] border border-[#3a2020] bg-[#1f0e0e] px-[11px] py-[9px]">
          <span className="flex-1 text-[11.5px] text-loom-red-soft">✗ Exited with error</span>
          <Button variant="destructive" size="sm" onClick={retry}>
            ↻ Retry
          </Button>
        </div>
      )}

      {/* terminal tail preview */}
      <div
        onClick={expand}
        className="relative mx-[11px] mb-[11px] flex cursor-pointer flex-col justify-end overflow-hidden rounded-[10px] border border-loom-border bg-loom-terminal px-[11px] py-[9px] font-mono text-[10.5px] leading-[1.5] hover:border-loom-border-accent"
        style={{ height: 98 }}
      >
        {tail.map((ln, i) => (
          <div key={i} className="whitespace-pre-wrap [overflow-wrap:anywhere]" style={{ color: KIND[ln.k] }}>
            {ln.t}
          </div>
        ))}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[30px] bg-gradient-to-b from-loom-terminal to-transparent" />
        <div className="absolute bottom-[7px] right-2 flex items-center gap-1 rounded-[5px] border border-loom-border-strong bg-[#11141a] px-1.5 py-0.5 text-[9.5px] text-loom-dim-2">
          open <Maximize2 size={9} />
        </div>
      </div>

      {/* footer */}
      <div className="flex items-center gap-[13px] border-t border-loom-border px-[13px] py-[9px] font-mono text-[10.5px] text-loom-dim">
        <span>{fmtTok(w.tokens)} tok</span>
        <span className="text-loom-green-soft">{fmtCost(w.tokens)}</span>
        <span>{fmtEl(w.elapsed)}</span>
        <div className="flex-1" />
        <button type="button" onClick={() => openEdit('worktree', w.id, { a: w.branch, b: w.task, model: w.model })} className="cursor-pointer px-1 py-0.5 text-loom-muted-2 hover:text-loom-accent-soft">
          details
        </button>
        <button type="button" onClick={pauseToggle} className="cursor-pointer px-1 py-0.5 text-loom-muted-2 hover:text-loom-fg">
          {paused ? 'resume' : 'pause'}
        </button>
        <button
          type="button"
          onClick={() => askDelete('worktree', w.id, label)}
          className="cursor-pointer px-1 py-0.5 text-loom-muted-2 hover:text-loom-red-soft"
        >
          delete
        </button>
      </div>
    </div>
  )
}
