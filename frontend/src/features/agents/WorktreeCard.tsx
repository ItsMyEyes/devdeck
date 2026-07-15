import { useNavigate } from '@tanstack/react-router'
import { Maximize2, MoreHorizontal, Pause, Play, Trash2 } from 'lucide-react'
import { KIND, STATE } from '@/lib/constants'
import { fmtCost, fmtEl, fmtTok } from '@/lib/format'
import { worktreeLabel } from '@/lib/worktreeLabel'
import type { Worktree } from '@/store/types'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/ui/pill'
import { StatusDot } from '@/components/ui/status-dot'
import { WorktreeGlyph } from './WorktreeGlyph'
import { useMachines, useUpdateWorktree, useWorkspace } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'
import { useIsTauri } from '@/features/tabs/useIsTauri'

interface WorktreeCardProps {
  worktree: Worktree
  wsId: string
  projectId: string
  variant?: 'card' | 'list'
}

export function WorktreeCard({ worktree: w, wsId, projectId, variant = 'card' }: WorktreeCardProps) {
  const navigate = useNavigate()
  const updateWorktree = useUpdateWorktree()
  const openEdit = useLoomStore((s) => s.openEdit)
  const askDelete = useLoomStore((s) => s.askDelete)
  const showToast = useLoomStore((s) => s.showToast)
  const openWorktreeTab = useLoomStore((s) => s.openWorktreeTab)
  const isTauri = useIsTauri()
  const project = useWorkspace(wsId).data?.projects.find((candidate) => candidate.id === projectId)
  const machine = useMachines().data?.find((m) => m.id === project?.machineId)

  function approve(ok: boolean) {
    if (!machine) {
      showToast("Could not resolve this worktree's machine")
      return
    }
    updateWorktree.mutate({
      machine,
      id: w.id,
      patch: ok
        ? { state: 'running', pending: null, appendLine: { k: 'ok', t: '✓ approved — continuing' } }
        : { state: 'idle', pending: null, appendLine: { k: 'err', t: '✗ rejected by user — halted' } },
    })
  }
  function retry() {
    if (!machine) {
      showToast("Could not resolve this worktree's machine")
      return
    }
    updateWorktree.mutate({
      machine,
      id: w.id,
      patch: { state: 'running', appendLine: { k: 'sys', t: '↻ retrying with patched config…' } },
    })
  }
  function pauseToggle() {
    if (!machine) {
      showToast("Could not resolve this worktree's machine")
      return
    }
    const active = w.state === 'running' || w.state === 'waiting'
    updateWorktree.mutate({
      machine,
      id: w.id,
      patch: active
        ? { state: 'stopped', pending: null, appendLine: { k: 'sys', t: '⏸ paused by user' } }
        : { state: 'running', appendLine: { k: 'sys', t: '▶ resumed' } },
    })
  }
  const st = STATE[w.state]
  const label = worktreeLabel(project, w)
  const tail = w.lines.slice(-2)
  const paused = w.state === 'stopped' || w.state === 'idle'
  const baseLabel = w.root ? 'project root' : w.base || 'no base'
  const changeSummary = `+${w.added} −${w.removed}`
  const lastLine = tail[tail.length - 1]

  function expand() {
    if (isTauri) openWorktreeTab(wsId, projectId, w.id)
    navigate({ to: '/w/$wsId/p/$projectId/wt/$wtId', params: { wsId, projectId, wtId: w.id } })
  }

  if (variant === 'list') {
    return (
      <article className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-loom-border-card bg-loom-card px-3 py-2.5 transition-colors hover:border-loom-border-accent lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-[9px] bg-loom-surface-2">
            <WorktreeGlyph root={w.root} size={13} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <StatusDot color={st.color} size={7} />
              <button
                type="button"
                onClick={expand}
                title={label}
                className="min-w-0 truncate text-left text-[13px] font-semibold text-loom-fg-2 hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {label}
              </button>
              <span className="hidden truncate font-mono text-[10.5px] text-loom-dim sm:inline">
                — {w.task || 'interactive'}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-loom-dim">
              <span>{w.agent || 'shell'}</span>
              <span>{w.model || 'terminal'}</span>
              <span>{baseLabel}</span>
              <span>{changeSummary}</span>
              <span>{w.files}f</span>
              <span className="text-loom-green-soft">{fmtCost(w.tokens)}</span>
              {lastLine ? <span className="min-w-[120px] flex-1 truncate" style={{ color: KIND[lastLine.k] }}>{lastLine.t}</span> : null}
            </div>
          </div>
        </div>

        <div className="flex flex-none items-center gap-1.5 pl-12 lg:pl-0">
          <Pill color={st.color}>{st.label}</Pill>
          <button
            type="button"
            onClick={expand}
            className="flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-loom-border-accent bg-loom-accent-tint px-2.5 text-[11.5px] font-semibold text-loom-accent-soft hover:bg-loom-accent-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Maximize2 size={12} />
            Open
          </button>
          <button
            type="button"
            aria-label={`${paused ? 'Resume' : 'Pause'} ${label}`}
            onClick={pauseToggle}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-loom-surface-2 text-loom-muted hover:bg-loom-popover hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {paused ? <Play size={12} /> : <Pause size={12} />}
          </button>
          <button
            type="button"
            aria-label={`Edit ${label}`}
            onClick={() => openEdit('worktree', w.id, { a: w.branch, b: w.task, model: w.model })}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-loom-surface-2 text-loom-muted hover:bg-loom-popover hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </article>
    )
  }

  return (
    <article className="group flex min-h-[150px] flex-col overflow-hidden rounded-[13px] border border-loom-border-card bg-loom-card transition-colors hover:border-loom-border-accent">
      <div className="flex items-start gap-3 px-3 pb-2 pt-3">
        <div className="flex h-11 w-11 flex-none items-center justify-center rounded-[10px] bg-loom-surface-2">
          <WorktreeGlyph root={w.root} size={15} />
        </div>

        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <StatusDot color={st.color} size={7} />
            <button
              type="button"
              onClick={expand}
              title={label}
              className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-loom-fg-2 hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {label}
            </button>
          </div>
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-loom-dim">
            {w.agent || 'shell'} · {w.model || 'terminal'}
          </div>
        </div>

        <div className="flex flex-none items-center gap-1">
          <button
            type="button"
            aria-label={`Delete ${label}`}
            onClick={() => askDelete('worktree', w.id, label)}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-loom-dim hover:bg-loom-red-tint hover:text-loom-red-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-3">
        <Pill color={st.color}>{st.label}</Pill>
        <span className="rounded-md bg-loom-surface-2 px-2 py-1 font-mono text-[10px] text-loom-muted-2">
          {baseLabel}
        </span>
        <span className="rounded-md bg-loom-surface-2 px-2 py-1 font-mono text-[10px] text-loom-muted-2">
          {changeSummary}
        </span>
        <span className="rounded-md bg-loom-surface-2 px-2 py-1 font-mono text-[10px] text-loom-muted-2">
          {w.files} files
        </span>
      </div>

      <div className="mx-3 my-2 h-px bg-loom-border" />

      <div className="grid grid-cols-2 gap-2 px-3 pb-3">
        <button
          type="button"
          onClick={expand}
          className="flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-loom-border-accent bg-loom-accent-tint text-[12px] font-semibold text-loom-accent-soft hover:bg-loom-accent-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Maximize2 size={13} />
          Open
        </button>
        <button
          type="button"
          onClick={() => openEdit('worktree', w.id, { a: w.branch, b: w.task, model: w.model })}
          className="flex h-8 cursor-pointer items-center justify-center rounded-md bg-loom-surface-2 text-[12px] font-semibold text-loom-muted hover:bg-loom-popover hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Details
        </button>
      </div>
    </article>
  )
}
