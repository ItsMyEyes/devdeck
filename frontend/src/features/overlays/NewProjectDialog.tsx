import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useCloneProject, useCreateProject, useWorkspace } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

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
  const np = useLoomStore((s) => s.newProject)
  const setNewProject = useLoomStore((s) => s.setNewProject)
  const closeNewProject = useLoomStore((s) => s.closeNewProject)
  const setSidebarOpen = useLoomStore((s) => s.setSidebarOpen)
  const showToast = useLoomStore((s) => s.showToast)
  const openBrowse = useLoomStore((s) => s.openBrowse)
  const ws = useWorkspace(wsId).data
  const createProject = useCreateProject()
  const cloneProject = useCloneProject()

  const mode = np.mode
  const cloneFolder = np.cloneFolder.trim() || repoFolderName(np.repo)
  const cloneTarget = joinPath(np.cloneParent, cloneFolder)
  const busy = createProject.isPending || cloneProject.isPending
  const canSubmit =
    !!wsId &&
    !busy &&
    (mode === 'local' ? np.path.trim().length > 0 : np.repo.trim().length > 0 && cloneFolder.length > 0)
  const localHint = np.path ? `loom will scan ${np.path} for a .git directory` : 'pick a folder that contains a git repository'
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
        { wsId, body: { name: np.name.trim() || cloneFolder, path: cloneTarget, repo: np.repo } },
        {
          onSuccess: (project) => onCreated(project, 'Cloned'),
          onError: (err) => onError(err, 'Failed to clone project'),
        },
      )
      return
    }
    createProject.mutate(
      { wsId, body: { name: np.name, path: np.path } },
      {
        onSuccess: (project) => onCreated(project, 'Added'),
        onError: (err) => onError(err, 'Failed to add project'),
      },
    )
  }

  return (
    <Dialog open={np.open} onOpenChange={(o) => !o && !busy && closeNewProject()} width={560}>
      <div className="mb-1 flex items-center gap-2.5">
        <span className="h-[13px] w-[13px] rounded border-[1.5px] border-loom-accent" />
        <DialogTitle>New project</DialogTitle>
      </div>
      <DialogDescription className="mb-[18px]">into workspace · {ws?.name ?? '—'}</DialogDescription>

      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-loom-border-strong bg-loom-bg p-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => setNewProject({ mode: 'local' })}
          className={cn(
            'h-8 rounded-lg font-mono text-[11.5px] transition-colors',
            mode === 'local' ? 'bg-loom-popover text-loom-fg' : 'text-loom-muted hover:text-loom-fg-2',
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
            mode === 'clone' ? 'bg-loom-popover text-loom-fg' : 'text-loom-muted hover:text-loom-fg-2',
          )}
        >
          Clone from GitHub
        </button>
      </div>

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
              className="flex-none bg-loom-elevated"
              onClick={() => openBrowse('newPath', np.path)}
            >
              Browse…
            </Button>
          </div>
          <div className="mb-3.5 font-mono text-[10.5px] text-loom-dim-2">{localHint}</div>
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
              className="flex-none bg-loom-elevated"
              onClick={() => openBrowse('cloneParent', np.cloneParent)}
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
          <div className="mb-3.5 font-mono text-[10.5px] text-loom-dim-2">{cloneHint}</div>
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
