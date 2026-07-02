import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useScope } from '@/features/useScope'
import { useCreateProject, useWorkspace } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

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

  const hint = np.path ? `loom will scan ${np.path} for a .git directory` : 'pick a folder that contains a git repository'

  function submit() {
    if (!wsId) return
    createProject.mutate(
      { wsId, body: { name: np.name, path: np.path } },
      {
        onSuccess: (project) => {
          closeNewProject()
          setSidebarOpen(false)
          showToast('Added "' + project.name + '" to ' + (ws?.name ?? '') + ' · ' + project.path)
          navigate({ to: '/w/$wsId/p/$projectId', params: { wsId, projectId: project.id } })
        },
      },
    )
  }

  return (
    <Dialog open={np.open} onOpenChange={(o) => !o && closeNewProject()} width={480}>
      <div className="mb-1 flex items-center gap-2.5">
        <span className="h-[13px] w-[13px] rounded border-[1.5px] border-loom-accent" />
        <DialogTitle>New project</DialogTitle>
      </div>
      <DialogDescription className="mb-[18px]">into workspace · {ws?.name ?? '—'}</DialogDescription>

      <Label>Local folder</Label>
      <div className="mb-1.5 flex gap-2">
        <Input value={np.path} onChange={(e) => setNewProject({ path: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} placeholder="~/dev/my-app" className="font-mono" />
        <Button variant="secondary" size="lg" className="flex-none bg-loom-elevated" onClick={() => openBrowse('new')}>
          Browse…
        </Button>
      </div>
      <div className="mb-3.5 font-mono text-[10.5px] text-loom-dim-2">{hint}</div>

      <Label>Project name</Label>
      <Input value={np.name} onChange={(e) => setNewProject({ name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} placeholder="auto from folder" className="mb-5" />

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={closeNewProject}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={createProject.isPending}>
          {createProject.isPending ? 'Adding…' : 'Add project →'}
        </Button>
      </div>
    </Dialog>
  )
}
