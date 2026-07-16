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
  useMachinesHealth,
  useProjectBranches,
  useWorkspaces,
} from '@/features/data/queries'
import { useScope } from '@/features/useScope'
import { useLoomStore } from '@/store/useLoomStore'
import { useIsTauri } from '@/features/tabs/useIsTauri'

export function SpawnDialog() {
  const navigate = useNavigate()
  const { wsId } = useScope()
  const spawn = useLoomStore((s) => s.spawn)
  const setSpawn = useLoomStore((s) => s.setSpawn)
  const closeSpawn = useLoomStore((s) => s.closeSpawn)
  const setSidebarOpen = useLoomStore((s) => s.setSidebarOpen)
  const openWorktreeTab = useLoomStore((s) => s.openWorktreeTab)
  const isTauri = useIsTauri()
  const workspaces = useWorkspaces().data ?? []
  const machinesQuery = useMachines()
  const machines = machinesQuery.data ?? []
  const machineHealth = useMachinesHealth(machines)
  const createWorktree = useCreateWorktree()
  const projectWorkspace = spawn.projectId
    ? workspaces.find((workspace) => workspace.projects.some((candidate) => candidate.id === spawn.projectId))
    : undefined
  const workspace = workspaces.find((candidate) => candidate.id === wsId) ?? projectWorkspace
  // A project whose machine is offline (or missing) can't actually run
  // anything — surfaced the same way an offline machine is in a Select:
  // disabled and labeled, rather than silently letting the user pick it and
  // fail on submit.
  const projectOptions = (workspace?.projects ?? []).map((candidate) => {
    const candidateMachine = machines.find((m) => m.id === candidate.machineId)
    const candidateOffline = !candidateMachine || machineHealth.get(candidateMachine.id)?.status === 'offline'
    return {
      value: candidate.id,
      label: candidateOffline ? `${candidate.name} (offline)` : candidate.name,
      disabled: candidateOffline,
    }
  })
  const project = workspaces.flatMap((candidate) => candidate.projects).find((candidate) => candidate.id === spawn.projectId)
  const machine = machines.find((candidate) => candidate.id === project?.machineId)
  const machineOnline = !!machine && machineHealth.get(machine.id)?.status !== 'offline'
  const branches = useProjectBranches(machine, project?.id, project?.path).data ?? []

  // Dynamic agent/model data from backend — reflects whichever machine this
  // project is assigned to, since installed agents are a machine property.
  const agents = useAgents(machine).data ?? []
  const installedAgents = agents.filter((agent) => agent.installed)

  // Default agent from the current model selection (guess from model ID prefix)
  const defaultAgentId = installedAgents.find((agent) => spawn.model.startsWith(agent.id))?.id ?? installedAgents[0]?.id ?? ''
  const [agentId, setAgentId] = useState(defaultAgentId)

  const models = useAgentModels(machine, agentId).data ?? []

  const branchMode = spawn.mode !== 'root'
  const canSubmit = Boolean(project && machine) && machineOnline && !createWorktree.isPending

  useEffect(() => {
    if (!spawn.open || !spawn.chooseProject || spawn.projectId || !workspace || machinesQuery.isPending) return
    const preferredProject =
      workspace.projects.find((candidate) => {
        const candidateMachine = machines.find((m) => m.id === candidate.machineId)
        return candidateMachine && machineHealth.get(candidateMachine.id)?.status !== 'offline'
      }) ??
      workspace.projects.find((candidate) => machines.some((candidateMachine) => candidateMachine.id === candidate.machineId)) ??
      workspace.projects[0]
    if (preferredProject) setSpawn({ projectId: preferredProject.id })
  }, [machineHealth, machines, machinesQuery.isPending, setSpawn, spawn.chooseProject, spawn.open, spawn.projectId, workspace])

  useEffect(() => {
    if (!spawn.open || installedAgents.some((agent) => agent.id === agentId)) return
    if (agentId !== defaultAgentId) setAgentId(defaultAgentId)
  }, [agentId, defaultAgentId, installedAgents, spawn.open])

  useEffect(() => {
    if (!spawn.open || !branchMode || models.length === 0 || models.some((model) => model.id === spawn.model)) return
    setSpawn({ model: models[0].id })
  }, [branchMode, models, setSpawn, spawn.model, spawn.open])

  useEffect(() => {
    if (branchMode && branches.length > 0 && !branches.includes(spawn.base)) {
      setSpawn({ base: branches[0] })
    }
  }, [branchMode, branches, spawn.base, setSpawn])

  function submit() {
    const projectId = project?.id
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
        onSuccess: (worktree) => {
          closeSpawn()
          setSidebarOpen(false)
          const targetWsId = workspaces.find((candidate) => candidate.projects.some((candidateProject) => candidateProject.id === projectId))?.id
          if (targetWsId) {
            if (isTauri) openWorktreeTab(targetWsId, projectId, worktree.id)
            navigate({
              to: '/w/$wsId/p/$projectId/wt/$wtId',
              params: { wsId: targetWsId, projectId, wtId: worktree.id },
            })
          }
        },
      },
    )
  }

  return (
    <Dialog open={spawn.open} onOpenChange={(open) => !open && closeSpawn()} width={480}>
      <div className="mb-1 flex items-center gap-2.5">
        {branchMode ? <GitBranch size={14} className="text-loom-accent" /> : <House size={14} className="text-loom-purple" />}
        <DialogTitle>{branchMode ? 'New worktree' : 'Root terminal'}</DialogTitle>
      </div>
      <DialogDescription className="mb-4">
        {branchMode
          ? `git worktree add${project ? ` · ${project.name}` : ''}`
          : `terminal in project root · no branch${project ? ` · ${project.path}` : ''}`}
      </DialogDescription>

      {spawn.chooseProject ? (
        <div className="mb-4">
          <Label>Project</Label>
          {projectOptions.length > 0 ? (
            <Select
              value={spawn.projectId ?? ''}
              onValueChange={(projectId) => setSpawn({ projectId })}
              options={projectOptions}
              aria-label="Project"
            />
          ) : (
            <p className="mt-1 font-mono text-[11px] text-loom-dim">No projects in this workspace.</p>
          )}
          {project && !machine ? (
            <p className="mt-1.5 font-mono text-[11px] text-loom-red-soft">Select a project with an assigned machine.</p>
          ) : project && machine && !machineOnline ? (
            <p className="mt-1.5 font-mono text-[11px] text-loom-red-soft">"{machine.name}" is offline — can't connect.</p>
          ) : null}
        </div>
      ) : project && !machine ? (
        <p className="mb-4 font-mono text-[11px] text-loom-red-soft">This project has no available machine.</p>
      ) : project && machine && !machineOnline ? (
        <p className="mb-4 font-mono text-[11px] text-loom-red-soft">"{machine.name}" is offline — can't connect.</p>
      ) : null}

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
            onChange={(event) => setSpawn({ branch: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            }}
            placeholder="feat/my-feature"
            className="font-mono"
          />
        </div>
      )}

      {branchMode && (
        <div className="mb-3.5">
          <Label>Description</Label>
          <Textarea
            value={spawn.task}
            onChange={(event) => setSpawn({ task: event.target.value })}
            placeholder="Describe what this agent should do…"
            className="h-[70px]"
          />
        </div>
      )}

      {branchMode && (
        <div className="mb-5 flex flex-wrap gap-3">
          {/* <div className="min-w-[140px] flex-1">
            <Label>Base branch</Label>
            <Select value={spawn.base} onValueChange={(base) => setSpawn({ base })} options={baseOptions} />
          </div> */}
          {/* <div className="min-w-[140px] flex-1">
            <Label>Agent</Label>
            <Select value={agentId} onValueChange={handleAgentChange} options={agentOptions} />
          </div>
          <div className="min-w-[140px] flex-1">
            <Label>Model</Label>
            <Select value={spawn.model} onValueChange={(model) => setSpawn({ model })} options={modelOptions} />
          </div> */}
        </div>
      )}

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={closeSpawn}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
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
