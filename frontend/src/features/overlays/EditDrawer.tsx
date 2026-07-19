import { X } from 'lucide-react'
import { STATE } from '@/lib/constants'
import { fmtCost, fmtEl, fmtTok } from '@/lib/format'
import { worktreeLabel } from '@/lib/worktreeLabel'
import type { Workspace } from '@/store/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { SideDrawer } from '@/components/ui/drawer'
import { StatusDot } from '@/components/ui/status-dot'
import { Textarea } from '@/components/ui/textarea'
import { WorktreeGlyph } from '@/features/agents/WorktreeGlyph'
import {
  useAgents,
  useAgentModels,
  useMachines,
  useProjectBranches,
  useUpdateProject,
  useUpdateWorkspace,
  useUpdateWorktree,
  useWorkspaces,
} from '@/features/data/queries'
import { findProject, findWorktree, findWs, projectOfWorktree, useDevDeckStore, wsOfProject } from '@/store/useDevDeckStore'

interface EditView {
  title: string
  sub: string
  dotColor: string
  isWorktree: boolean
  isRoot: boolean
  meta: { k: string; v: string }[]
}

export function EditDrawer() {
  const edit = useDevDeckStore((s) => s.edit)
  const setEdit = useDevDeckStore((s) => s.setEdit)
  const askDelete = useDevDeckStore((s) => s.askDelete)
  const closeEdit = useDevDeckStore((s) => s.closeEdit)
  const openBrowse = useDevDeckStore((s) => s.openBrowse)
  const showToast = useDevDeckStore((s) => s.showToast)
  const workspaces = useWorkspaces().data ?? []
  const updateWorktree = useUpdateWorktree()
  const updateProject = useUpdateProject()
  const updateWorkspace = useUpdateWorkspace()

  const editWorktree = edit.kind === 'worktree' && edit.id ? findWorktree(workspaces, edit.id) : null
  const editProject =
    edit.kind === 'worktree' && edit.id
      ? projectOfWorktree(workspaces, edit.id)
      : edit.kind === 'project' && edit.id
        ? findProject(workspaces, edit.id)
        : undefined
  const machines = useMachines().data
  const editMachine = machines?.find((m) => m.id === editProject?.machineId)
  const branches = useProjectBranches(editMachine, editProject?.id, editProject?.path).data ?? []
  const branchOptions = branches.map((b) => ({ value: b, label: b }))
  const branchLocked = editWorktree?.state === 'running' || editWorktree?.state === 'waiting'

  // Dynamic model options from backend — reflects the edited worktree's own
  // machine, since installed agents are a machine property.
  const agents = useAgents(editMachine).data ?? []
  const defaultAgent = agents[0]?.id
  const models = useAgentModels(editMachine, defaultAgent).data ?? []
  const modelOptions = models.map((m) => ({ value: m.id, label: m.name }))

  const open = !!edit.kind
  const view = buildView(edit.kind, edit.id, workspaces)
  const saving = updateWorktree.isPending || updateProject.isPending || updateWorkspace.isPending

  function saveEdit() {
    const { kind, id } = edit
    if (!kind || !id) return
    if (kind === 'worktree') {
      if (!editMachine) {
        showToast("Could not resolve this worktree's machine")
        return
      }
      const w = findWorktree(workspaces, id)
      const branch = edit.a.trim() || (w?.branch ?? '')
      updateWorktree.mutate(
        { machine: editMachine, id, patch: { branch, task: edit.b, model: edit.model } },
        { onSuccess: () => {
          closeEdit()
          showToast('Updated ⎇ ' + branch)
        } },
      )
    } else if (kind === 'project') {
      const p = findProject(workspaces, id)
      const name = edit.a.trim() || (p?.name ?? '')
      const path = edit.b.trim() || (p?.path ?? '')
      updateProject.mutate({ id, patch: { name, path } }, { onSuccess: () => {
        closeEdit()
        showToast('Updated project ' + name)
      } })
    } else {
      const ws = findWs(workspaces, id)
      const name = edit.a.trim() || (ws?.name ?? '')
      updateWorkspace.mutate({ id, patch: { name } }, { onSuccess: () => {
        closeEdit()
        showToast('Updated workspace ' + name)
      } })
    }
  }

  function onAskDelete() {
    if (edit.kind && edit.id) askDelete(edit.kind, edit.id, view?.title ?? '')
  }

  return (
    <SideDrawer open={open} onOpenChange={(o) => !o && closeEdit()} width={380} z={55}>
      {view && (
        <>
          {/* header */}
          <div className="flex flex-none items-start gap-2.5 border-b border-devdeck-border px-[18px] pb-3.5 pt-[18px]">
            <StatusDot color={view.dotColor} style={{ marginTop: 4 }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 truncate font-mono text-[14px] font-semibold text-devdeck-fg">
                {view.isWorktree && <WorktreeGlyph root={view.isRoot} size={13} />}
                <span className="truncate">{view.title}</span>
              </div>
              <div className="mt-1 font-mono text-[11px] text-devdeck-dim">{view.sub}</div>
            </div>
            <button
              onClick={closeEdit}
              aria-label="Close"
              className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md border border-devdeck-border-strong text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-fg"
            >
              <X size={14} />
            </button>
          </div>

          {/* body */}
          <div className="flex-1 overflow-auto p-[18px]">
            {view.meta.length > 0 && (
              <div className="mb-[18px] rounded-[11px] border border-devdeck-border-card bg-devdeck-bg px-3.5 py-3 font-mono text-[11.5px] leading-[1.7] text-devdeck-muted">
                {view.meta.map((row) => (
                  <div key={row.k} className="flex gap-2.5">
                    <span className="w-[70px] flex-none text-devdeck-dim">{row.k}</span>
                    <span className="truncate text-devdeck-fg-2">{row.v}</span>
                  </div>
                ))}
              </div>
            )}

            {edit.kind === 'worktree' && (
              <>
                {!view.isRoot && (
                  <div className="mb-4">
                    <Label>Branch name</Label>
                    <Select
                      value={edit.a}
                      onValueChange={(v) => setEdit({ a: v })}
                      options={branchOptions}
                      disabled={branchLocked}
                    />
                    {branchLocked && (
                      <div className="mt-1.5 font-mono text-[10.5px] text-devdeck-dim">pause to change branch</div>
                    )}
                  </div>
                )}
                <div className="mb-4">
                  <Label>Task</Label>
                  <Textarea value={edit.b} onChange={(e) => setEdit({ b: e.target.value })} className="h-[84px]" />
                </div>
                <div>
                  <Label>Model</Label>
                  <Select value={edit.model} onValueChange={(v) => setEdit({ model: v })} options={modelOptions} />
                </div>
              </>
            )}

            {edit.kind === 'project' && (
              <>
                <div className="mb-4">
                  <Label>Project name</Label>
                  <Input value={edit.a} onChange={(e) => setEdit({ a: e.target.value })} />
                </div>
                <Label>Local path</Label>
                <div className="flex gap-2">
                  <Input value={edit.b} onChange={(e) => setEdit({ b: e.target.value })} className="font-mono" />
                  <Button
                    variant="secondary"
                    size="lg"
                    className="flex-none bg-devdeck-elevated"
                    onClick={() => openBrowse('edit', edit.b, editProject?.machineId)}
                  >
                    Browse…
                  </Button>
                </div>
              </>
            )}

            {edit.kind === 'workspace' && (
              <div>
                <Label>Workspace name</Label>
                <Input value={edit.a} onChange={(e) => setEdit({ a: e.target.value })} />
              </div>
            )}
          </div>

          {/* footer */}
          <div className="flex flex-none items-center gap-2.5 border-t border-devdeck-border px-[18px] py-3.5">
            <Button variant="destructive" onClick={onAskDelete}>
              Delete
            </Button>
            <div className="flex-1" />
            <Button variant="secondary" onClick={closeEdit}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={saving}>
              {saving ? 'Updating…' : 'Update'}
            </Button>
          </div>
        </>
      )}
    </SideDrawer>
  )
}

function buildView(kind: string | null, id: string | null, workspaces: Workspace[]): EditView | null {
  if (!kind || !id) return null
  if (kind === 'worktree') {
    const w = findWorktree(workspaces, id)
    if (!w) return null
    const st = STATE[w.state]
    const p = workspaces.flatMap((ws) => ws.projects).find((pr) => pr.worktrees.some((x) => x.id === id))
    const base = p?.path ?? ''
    return {
      title: worktreeLabel(p, w),
      sub: `${st.label} · ${w.model}`,
      dotColor: st.color,
      isWorktree: true,
      isRoot: !!w.root,
      meta: [
        { k: 'path', v: w.root ? base : `${base}/.wt/${w.id}` },
        { k: 'base', v: w.root ? `root · ${w.base}` : `${w.base}  ↑${w.ahead} ↓${w.behind}` },
        { k: 'diff', v: `+${w.added} −${w.removed} · ${w.files} files` },
        { k: 'usage', v: `${fmtTok(w.tokens)} tok · ${fmtCost(w.tokens)} · ${fmtEl(w.elapsed)}` },
      ],
    }
  }
  if (kind === 'project') {
    const p = findProject(workspaces, id)
    if (!p) return null
    const prun = p.worktrees.filter((w) => w.state === 'running').length
    const pw = wsOfProject(workspaces, p.id)
    return {
      title: p.name,
      sub: `${p.worktrees.length} worktrees`,
      dotColor: prun > 0 ? STATE.running.color : '#5f6672',
      isWorktree: false,
      isRoot: false,
      meta: [
        { k: 'workspace', v: pw?.name ?? '—' },
        { k: 'path', v: p.path },
        { k: 'repo', v: p.repo || '—' },
        { k: 'worktrees', v: String(p.worktrees.length) },
      ],
    }
  }
  const ws = findWs(workspaces, id)
  if (!ws) return null
  const wcount = ws.projects.reduce((a, p) => a + p.worktrees.length, 0)
  return {
    title: ws.name,
    sub: `${ws.projects.length} projects`,
    dotColor: '#6d8bff',
    isWorktree: false,
    isRoot: false,
    meta: [
      { k: 'projects', v: String(ws.projects.length) },
      { k: 'worktrees', v: String(wcount) },
    ],
  }
}
