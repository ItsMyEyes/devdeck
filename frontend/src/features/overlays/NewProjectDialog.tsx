import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useCloneProject, useCreateProject, useMachines, useMachinesHealth, useWorkspace } from '@/features/data/queries'
import { useDevDeckStore } from '@/store/useDevDeckStore'

function repoFolderName(repo: string) {
  const trimmed = repo.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  if (!trimmed) return ''
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf(':'))
  const name = trimmed.slice(index + 1).trim()
  return name === '.' || name === '..' ? '' : name
}

function joinPath(parent: string, child: string) {
  const base = parent.trim() || '~'
  const name = child.trim()
  if (!name) return base
  return base.endsWith('/') ? base + name : `${base}/${name}`
}

export function NewProjectDialog() {
  const navigate = useNavigate()
  const { wsId } = useScope()
  const np = useDevDeckStore((s) => s.newProject)
  const setNewProject = useDevDeckStore((s) => s.setNewProject)
  const closeNewProject = useDevDeckStore((s) => s.closeNewProject)
  const setSidebarOpen = useDevDeckStore((s) => s.setSidebarOpen)
  const showToast = useDevDeckStore((s) => s.showToast)
  const openBrowse = useDevDeckStore((s) => s.openBrowse)
  const ws = useWorkspace(wsId).data
  const machines = useMachines().data ?? []
  const machineHealth = useMachinesHealth(machines)
  const createProject = useCreateProject()
  const cloneProject = useCloneProject()

  // The desktop shell registers itself as a Machine with isLocal true, so when it's
  // present, skip the manual 'Select a machine…' step and default straight to it.
  useEffect(() => {
    if (!np.open || np.machineId) return
    const local = machines.find((m) => m.isLocal)
    if (local) setNewProject({ machineId: local.id })
  }, [np.open, np.machineId, machines, setNewProject])

  const mode = np.mode
  const cloneFolder = np.cloneFolder.trim() || repoFolderName(np.repo)
  const cloneTarget = joinPath(np.cloneParent, cloneFolder)
  const busy = createProject.isPending || cloneProject.isPending
  const canSubmit =
    !!wsId &&
    !busy &&
    np.machineId.length > 0 &&
    (mode === 'local' ? np.path.trim().length > 0 : np.repo.trim().length > 0 && cloneFolder.length > 0)
  const localHint = np.path ? `devdeck will scan ${np.path} for a .git directory` : 'pick a folder that contains a git repository'
  const cloneHint =
    np.repo.trim() && cloneFolder
      ? `clone target · ${cloneTarget}`
      : 'paste a GitHub HTTPS/SSH URL, then choose where to clone it'

  function onCreated(project: { id: string; name: string; path: string }, verb: string) {
    closeNewProject()
    setSidebarOpen(false)
    showToast(verb + ' "' + project.name + '" to ' + (ws?.name ?? '') + ' · ' + project.path)
    navigate({ to: '/w/$wsId/p/$projectId', params: { wsId: wsId!, projectId: project.id } })
  }

  function onError(err: unknown, fallback: string) {
    showToast(err instanceof Error ? err.message : fallback)
  }

  function submit() {
    if (!wsId || !canSubmit) return
    if (mode === 'clone') {
      cloneProject.mutate(
        { wsId, body: { name: np.name.trim() || cloneFolder, path: cloneTarget, repo: np.repo, machineId: np.machineId } },
        {
          onSuccess: (project) => onCreated(project, 'Cloned'),
          onError: (err) => onError(err, 'Failed to clone project'),
        },
      )
      return
    }
    createProject.mutate(
      { wsId, body: { name: np.name, path: np.path, machineId: np.machineId } },
      {
        onSuccess: (project) => onCreated(project, 'Added'),
        onError: (err) => onError(err, 'Failed to add project'),
      },
    )
  }

  return (
    <Dialog open={np.open} onOpenChange={(o) => !o && !busy && closeNewProject()} width={560}>
      <div className="mb-1 flex items-center gap-2.5">
        <span className="h-[13px] w-[13px] rounded border-[1.5px] border-devdeck-line" />
        <DialogTitle>New project</DialogTitle>
      </div>
      <DialogDescription className="mb-[18px]">into workspace · {ws?.name ?? '—'}</DialogDescription>

      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-devdeck-border-strong bg-devdeck-pane p-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => setNewProject({ mode: 'local' })}
          className={cn(
            'h-8 rounded-lg font-mono text-[11.5px] transition-colors',
            mode === 'local' ? 'bg-devdeck-glass-solid text-devdeck-fg' : 'text-devdeck-fg-2 hover:text-devdeck-fg-2',
          )}
        >
          Local folder
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setNewProject({ mode: 'clone' })}
          className={cn(
            'h-8 rounded-lg font-mono text-[11.5px] transition-colors',
            mode === 'clone' ? 'bg-devdeck-glass-solid text-devdeck-fg' : 'text-devdeck-fg-2 hover:text-devdeck-fg-2',
          )}
        >
          Clone from GitHub
        </button>
      </div>

      <Label>Machine</Label>
      <select
        value={np.machineId}
        disabled={busy}
        onChange={(e) => setNewProject({ machineId: e.target.value })}
        className="mb-3.5 h-9 w-full rounded-lg border border-devdeck-border-strong bg-devdeck-pane px-2.5 font-mono text-[12.5px] text-devdeck-fg-2"
      >
        <option value="">Select a machine…</option>
        {machines.map((m) => {
          const offline = machineHealth.get(m.id)?.status === 'offline'
          return (
            <option key={m.id} value={m.id} disabled={offline} style={offline ? { color: '#f87171' } : undefined}>
              {m.name}
              {offline ? ' (offline)' : ''}
            </option>
          )
        })}
      </select>

      {mode === 'local' ? (
        <>
          <Label>Local folder</Label>
          <div className="mb-1.5 flex gap-2">
            <Input
              value={np.path}
              disabled={busy}
              onChange={(e) => setNewProject({ path: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder="~/dev/my-app"
              className="font-mono"
            />
            <Button
              variant="secondary"
              size="lg"
              disabled={busy}
              className="flex-none bg-devdeck-glass-solid"
              onClick={() => openBrowse('newPath', np.path, np.machineId)}
            >
              Browse…
            </Button>
          </div>
          <div className="mb-3.5 font-mono text-[10.5px] text-devdeck-fg-2">{localHint}</div>
        </>
      ) : (
        <>
          <Label>GitHub repository</Label>
          <Input
            value={np.repo}
            disabled={busy}
            onChange={(e) => setNewProject({ repo: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="https://github.com/org/repo.git"
            className="mb-3 font-mono"
          />

          <Label>Clone into</Label>
          <div className="mb-3 flex gap-2">
            <Input
              value={np.cloneParent}
              disabled={busy}
              onChange={(e) => setNewProject({ cloneParent: e.target.value })}
              placeholder="~/dev"
              className="font-mono"
            />
            <Button
              variant="secondary"
              size="lg"
              disabled={busy}
              className="flex-none bg-devdeck-glass-solid"
              onClick={() => openBrowse('cloneParent', np.cloneParent, np.machineId)}
            >
              Browse…
            </Button>
          </div>

          <Label>Folder name</Label>
          <Input
            value={np.cloneFolder}
            disabled={busy}
            onChange={(e) => setNewProject({ cloneFolder: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={repoFolderName(np.repo) || 'repo-folder'}
            className="mb-1.5 font-mono"
          />
          <div className="mb-3.5 font-mono text-[10.5px] text-devdeck-fg-2">{cloneHint}</div>
        </>
      )}

      <Label>Project name</Label>
      <Input
        value={np.name}
        disabled={busy}
        onChange={(e) => setNewProject({ name: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="auto from folder"
        className="mb-5"
      />

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={closeNewProject} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          {cloneProject.isPending ? 'Cloning…' : createProject.isPending ? 'Adding…' : mode === 'clone' ? 'Clone project →' : 'Add project →'}
        </Button>
      </div>
    </Dialog>
  )
}
