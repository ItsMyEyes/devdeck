import { useNavigate } from '@tanstack/react-router'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useScope } from '@/features/useScope'
import {
  useDeleteMachine,
  useDeleteProject,
  useDeleteWorkspace,
  useDeleteWorktree,
  useWorkspaces,
} from '@/features/data/queries'
import { projectOfWorktree, useLoomStore, wsOfProject } from '@/store/useLoomStore'

function bodyFor(kind: string, name: string) {
  if (kind === 'worktree')
    return `This removes the worktree, kills its terminal session and deletes the local working copy for branch "${name}". The branch itself is kept.`
  if (kind === 'workspace')
    return `This removes workspace "${name}" and every project inside it from loom. Your files on disk are not touched.`
  if (kind === 'machine')
    return `This removes machine "${name}" from the registry. Projects still pointing at it will show as unreachable until reassigned.`
  return `This removes project "${name}" and all of its worktrees from loom. Your files on disk are not touched.`
}

export function ConfirmDeleteDialog() {
  const navigate = useNavigate()
  const { wsId, projectId, wtId } = useScope()
  const confirm = useLoomStore((s) => s.confirmDelete)
  const cancelConfirm = useLoomStore((s) => s.cancelConfirm)
  const showToast = useLoomStore((s) => s.showToast)
  const workspaces = useWorkspaces().data ?? []
  const deleteWorktree = useDeleteWorktree()
  const deleteProject = useDeleteProject()
  const deleteWorkspace = useDeleteWorkspace()
  const deleteMachine = useDeleteMachine()

  const open = !!confirm

  function onDelete() {
    if (!confirm) return
    const { kind, id, name } = confirm
    const affectsCurrent =
      (kind === 'worktree' && wtId === id) ||
      (kind === 'project' && projectId === id) ||
      (kind === 'workspace' && wsId === id)
    const toast = () => showToast('Deleted ' + kind + ' "' + name + '"')

    if (kind === 'worktree') {
      const parent = projectOfWorktree(workspaces, id)
      const parentWs = parent ? wsOfProject(workspaces, parent.id) : null
      deleteWorktree.mutate(id, {
        onSuccess: () => {
          cancelConfirm()
          toast()
          if (affectsCurrent && parent && parentWs) {
            navigate({ to: '/w/$wsId/p/$projectId', params: { wsId: parentWs.id, projectId: parent.id } })
          }
        },
      })
    } else if (kind === 'project') {
      const ws = wsOfProject(workspaces, id)
      deleteProject.mutate(id, {
        onSuccess: () => {
          cancelConfirm()
          toast()
          // The workspace index route redirects to the next project (or AgentsEmpty).
          if (affectsCurrent && ws) navigate({ to: '/w/$wsId', params: { wsId: ws.id } })
        },
      })
    } else if (kind === 'machine') {
      deleteMachine.mutate(id, {
        onSuccess: () => {
          cancelConfirm()
          toast()
        },
      })
    } else {
      deleteWorkspace.mutate(id, {
        onSuccess: () => {
          cancelConfirm()
          toast()
          if (affectsCurrent) {
            const next = workspaces.find((w) => w.id !== id)
            if (next) navigate({ to: '/w/$wsId', params: { wsId: next.id } })
            else navigate({ to: '/' })
          }
        },
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && cancelConfirm()} width={400} z={70} className="border-loom-red-tint">
      <div className="mb-2.5 flex items-center gap-2.5">
        <TriangleAlert size={15} className="text-loom-red-soft" />
        <DialogTitle>Delete {confirm?.kind}</DialogTitle>
      </div>
      <DialogDescription className="mb-5 font-sans text-[12.5px] leading-[1.55] text-loom-muted">
        {confirm ? bodyFor(confirm.kind, confirm.name) : ''}
      </DialogDescription>
      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={cancelConfirm}>
          Cancel
        </Button>
        <Button variant="destructive-solid" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </Dialog>
  )
}
