import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { GitBranch, House } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  useAgents,
  useAgentModels,
  useCreateWorktree,
  useMachines,
  useProjectBranches,
  useWorkspaces,
} from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'
import { useIsTauri } from '@/features/tabs/useIsTauri'

export function SpawnDialog() {
  const navigate = useNavigate()
  const spawn = useLoomStore((s) => s.spawn)
  const setSpawn = useLoomStore((s) => s.setSpawn)
  const closeSpawn = useLoomStore((s) => s.closeSpawn)
  const setSidebarOpen = useLoomStore((s) => s.setSidebarOpen)
  const openWorktreeTab = useLoomStore((s) => s.openWorktreeTab)
  const isTauri = useIsTauri()
  const workspaces = useWorkspaces().data ?? []
  const createWorktree = useCreateWorktree()
  const project = workspaces.flatMap((w) => w.projects).find((p) => p.id === spawn.projectId)
  const machine = useMachines().data?.find((m) => m.id === project?.machineId)
  const branches = useProjectBranches(machine, project?.id, project?.path).data ?? []
  const baseOptions = branches.map((b) => ({ value: b, label: b }))

  // Dynamic agent/model data from backend
  const agents = useAgents().data ?? []
  const installedAgents = agents.filter((a) => a.installed)
  const agentOptions = installedAgents.map((a) => ({ value: a.id, label: a.name }))

  // Default agent from the current model selection (guess from model ID prefix)
  const defaultAgentId = installedAgents.find((a) => spawn.model.startsWith(a.id))?.id ?? installedAgents[0]?.id ?? ''
  const [agentId, setAgentId] = useState(defaultAgentId)

  const models = useAgentModels(agentId).data ?? []
  const modelOptions = models.map((m) => ({ value: m.id, label: m.name }))

  const branchMode = spawn.mode !== 'root'

  useEffect(() => {
    if (branchMode && branches.length > 0 && !branches.includes(spawn.base)) {
      setSpawn({ base: branches[0] })
    }
  }, [branchMode, branches, spawn.base, setSpawn])

  function submit() {
    const projectId = spawn.projectId
    if (!projectId || !machine || !project) return
    createWorktree.mutate(
      {
        machine,
        projectId,
        body: {
          mode: spawn.mode,
          // Root mode is a plain shell terminal — no agent is picked, so no
          // model/task must be sent, or the backend would treat it as an
          // agent session (see backend/internal/service/worktree.go Create).
          branch: spawn.branch,
          base: spawn.base,
          model: branchMode ? spawn.model : '',
          agent: branchMode ? agentId : '',
          task: branchMode ? spawn.task : '',
          path: project.path,
        },
      },
      {
        onSuccess: (wt) => {
          closeSpawn()
          setSidebarOpen(false)
          const wsId = workspaces.find((w) => w.projects.some((p) => p.id === projectId))?.id
          if (wsId) {
            if (isTauri) openWorktreeTab(wsId, projectId, wt.id)
            navigate({ to: '/w/$wsId/p/$projectId/wt/$wtId', params: { wsId, projectId, wtId: wt.id } })
          }
        },
      },
    )
  }

  const handleAgentChange = (v: string) => {
    setAgentId(v)
    const agent = installedAgents.find((a) => a.id === v)
    if (agent) {
      // Set model to the first model of the selected agent (fetched async)
    }
  }

  return (
    <Dialog open={spawn.open} onOpenChange={(o) => !o && closeSpawn()} width={480}>
      <div className="mb-1 flex items-center gap-2.5">
        {branchMode ? <GitBranch size={14} className="text-loom-accent" /> : <House size={14} className="text-loom-purple" />}
        <DialogTitle>{branchMode ? 'New worktree' : 'Root terminal'}</DialogTitle>
      </div>
      <DialogDescription className="mb-4">
        {branchMode
          ? `git worktree add · ${project?.name ?? ''}`
          : `terminal in project root · no branch · ${project?.path ?? ''}`}
      </DialogDescription>

      {/* mode tabs */}
      <div className="mb-4 flex gap-1.5 rounded-lg border border-loom-border-strong bg-loom-bg p-1">
        <ModeTab active={branchMode} onClick={() => setSpawn({ mode: 'branch' })}>
          <GitBranch size={13} />
          New branch
        </ModeTab>
        <ModeTab active={!branchMode} onClick={() => setSpawn({ mode: 'root' })}>
          <House size={13} />
          Project root
        </ModeTab>
      </div>

      {branchMode && (
        <div className="mb-3.5">
          <Label>Branch name</Label>
          <Input
            value={spawn.branch}
            onChange={(e) => setSpawn({ branch: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
            placeholder="feat/my-feature"
            className="font-mono"
          />
        </div>
      )}

      {branchMode && (
        <div className="mb-3.5">
          <Label>Task</Label>
          <Textarea
            value={spawn.task}
            onChange={(e) => setSpawn({ task: e.target.value })}
            placeholder="Describe what this agent should do…"
            className="h-[70px]"
          />
        </div>
      )}

      {branchMode && (
        <div className="mb-5 flex flex-wrap gap-3">
          <div className="min-w-[140px] flex-1">
            <Label>Base branch</Label>
            <Select value={spawn.base} onValueChange={(v) => setSpawn({ base: v })} options={baseOptions} />
          </div>
          <div className="min-w-[140px] flex-1">
            <Label>Agent</Label>
            <Select value={agentId} onValueChange={handleAgentChange} options={agentOptions} />
          </div>
          <div className="min-w-[140px] flex-1">
            <Label>Model</Label>
            <Select value={spawn.model} onValueChange={(v) => setSpawn({ model: v })} options={modelOptions} />
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={closeSpawn}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={createWorktree.isPending || !machine}>
          {createWorktree.isPending ? 'Creating…' : 'Create →'}
        </Button>
      </div>
    </Dialog>
  )
}

function ModeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex h-[30px] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[12px] font-medium transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'bg-transparent text-loom-muted hover:text-loom-fg',
      )}
    >
      {children}
    </button>
  )
}
