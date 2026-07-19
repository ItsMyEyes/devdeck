import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCreateWorkspace } from '@/features/data/queries'
import { useDevDeckStore } from '@/store/useDevDeckStore'

export function NewWorkspaceDialog() {
  const navigate = useNavigate()
  const nw = useDevDeckStore((s) => s.newWorkspace)
  const setNewWorkspace = useDevDeckStore((s) => s.setNewWorkspace)
  const closeNewWorkspace = useDevDeckStore((s) => s.closeNewWorkspace)
  const setSidebarOpen = useDevDeckStore((s) => s.setSidebarOpen)
  const showToast = useDevDeckStore((s) => s.showToast)
  const createWorkspace = useCreateWorkspace()

  function submit() {
    if (createWorkspace.isPending) return
    createWorkspace.mutate(
      { name: nw.name },
      {
        onSuccess: (workspace) => {
          closeNewWorkspace()
          setSidebarOpen(false)
          showToast('Created workspace "' + workspace.name + '"')
          navigate({ to: '/w/$wsId', params: { wsId: workspace.id } })
        },
      },
    )
  }

  return (
    <Dialog open={nw.open} onOpenChange={(o) => !o && closeNewWorkspace()} width={420}>
      <div className="mb-1 flex items-center gap-2.5">
        <span className="h-[18px] w-[18px] rounded-md" style={{ background: 'var(--devdeck-accent-gradient)' }} />
        <DialogTitle>New workspace</DialogTitle>
      </div>
      <DialogDescription className="mb-[18px]">group related projects together</DialogDescription>

      <Label>Workspace name</Label>
      <Input
        value={nw.name}
        onChange={(e) => setNewWorkspace({ name: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="e.g. Client X, Personal, Infra"
        className="mb-5"
        autoFocus
      />

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={closeNewWorkspace}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={createWorkspace.isPending}>
          {createWorkspace.isPending ? 'Creating…' : 'Create →'}
        </Button>
      </div>
    </Dialog>
  )
}
