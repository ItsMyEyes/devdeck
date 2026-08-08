import { useNavigate } from '@tanstack/react-router'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useScope } from '@/features/useScope'
import {
  useDeleteMachine,
  useDeleteProject,
  useDeleteSSHConnection,
  useDeleteWorkspace,
  useDeleteWorktree,
  useMachines,
  useSSHConnections,
  useUpdateSSHConnection,
  useWorkspaces,
} from '@/features/data/queries'
import { findProject, findWs, projectOfWorktree, useDevDeckStore, wsOfProject } from '@/store/useDevDeckStore'

function titleFor(kind: string) {
  return kind === 'ssh-group' ? 'group' : kind
}

function bodyFor(kind: string, name: string, groupHostCount: number) {
  if (kind === 'worktree')
    return `This removes the worktree, kills its terminal session and deletes the local working copy for branch "${name}". The branch itself is kept.`
  if (kind === 'workspace')
    return `This removes workspace "${name}" and every project inside it from devdeck. Your files on disk are not touched.`
  if (kind === 'machine')
    return `This removes machine "${name}" from the registry. Projects still pointing at it will show as unreachable until reassigned.`
  if (kind === 'ssh')
    return `This removes SSH connection "${name}" and its stored credentials. The remote host itself is not touched.`
  if (kind === 'ssh-group')
    return `This removes group "${name}" - ${groupHostCount} host${groupHostCount === 1 ? '' : 's'} move back to Ungrouped. The hosts themselves and their credentials are not touched.`
  return `This removes project "${name}" and all of its worktrees from devdeck. Your files on disk are not touched.`
}

export function ConfirmDeleteDialog() {
  const navigate = useNavigate()
  const { wsId, projectId, wtId } = useScope()
  const confirm = useDevDeckStore((s) => s.confirmDelete)
  const cancelConfirm = useDevDeckStore((s) => s.cancelConfirm)
  const showToast = useDevDeckStore((s) => s.showToast)
  const removeWorktreeLayout = useDevDeckStore((s) => s.removeWorktreeLayout)
  const closeWorktreeTab = useDevDeckStore((s) => s.closeWorktreeTab)
  const selectAgentsTab = useDevDeckStore((s) => s.selectAgentsTab)
  const workspaces = useWorkspaces().data ?? []
  const machines = useMachines().data
  const deleteWorktree = useDeleteWorktree()
  const deleteProject = useDeleteProject()
  const deleteWorkspace = useDeleteWorkspace()
  const deleteMachine = useDeleteMachine()
  const deleteSSHConnection = useDeleteSSHConnection()
  const sshConnections = useSSHConnections().data ?? []
  const updateSSHConnection = useUpdateSSHConnection()

  const open = !!confirm
  const groupAffectedConnections =
    confirm?.kind === 'ssh-group' ? sshConnections.filter((c) => c.group.trim() === confirm.name) : []

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
      const machine = machines?.find((m) => m.id === parent?.machineId)
      if (!machine) {
        showToast("Could not resolve this worktree's machine")
        return
      }
      deleteWorktree.mutate({ machine, id }, {
        onSuccess: () => {
          cancelConfirm()
          toast()
          removeWorktreeLayout(id)
          if (parentWs) closeWorktreeTab(parentWs.id, id)
          if (affectsCurrent && parent && parentWs) {
            selectAgentsTab(parentWs.id)
            navigate({ to: '/w/$wsId/p/$projectId', params: { wsId: parentWs.id, projectId: parent.id } })
          }
        },
      })
    } else if (kind === 'project') {
      const ws = wsOfProject(workspaces, id)
      // Cascade-deletes all of this project's worktrees — their persisted layouts
      // would otherwise orphan in localStorage forever (captured before the mutation
      // removes the project from the query cache).
      const worktreeIds = findProject(workspaces, id)?.worktrees.map((wt) => wt.id) ?? []
      deleteProject.mutate(id, {
        onSuccess: () => {
          cancelConfirm()
          toast()
          worktreeIds.forEach((worktreeId) => {
            removeWorktreeLayout(worktreeId)
            if (ws) closeWorktreeTab(ws.id, worktreeId)
          })
          if (affectsCurrent && ws) {
            selectAgentsTab(ws.id)
            navigate({ to: '/w/$wsId', params: { wsId: ws.id } })
          }
        },
      })
    } else if (kind === 'machine') {
      deleteMachine.mutate(id, {
        onSuccess: () => {
          cancelConfirm()
          toast()
        },
      })
    } else if (kind === 'ssh') {
      deleteSSHConnection.mutate(id, {
        onSuccess: () => {
          cancelConfirm()
          toast()
        },
      })
    } else if (kind === 'ssh-group') {
      Promise.all(
        groupAffectedConnections.map((c) => updateSSHConnection.mutateAsync({ id: c.id, patch: { group: '' } })),
      )
        .then(() => {
          cancelConfirm()
          showToast(`Removed group "${name}" - ${groupAffectedConnections.length} host(s) moved to Ungrouped`)
        })
        .catch((err) => showToast(err instanceof Error ? err.message : 'Failed to remove group'))
    } else {
      // Cascade-deletes every project in this workspace, and with it every worktree —
      // same layout-orphan concern as the project branch above, just one level higher.
      const worktreeIds = findWs(workspaces, id)?.projects.flatMap((p) => p.worktrees.map((wt) => wt.id)) ?? []
      deleteWorkspace.mutate(id, {
        onSuccess: () => {
          cancelConfirm()
          toast()
          worktreeIds.forEach(removeWorktreeLayout)
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
    <Dialog open={open} onOpenChange={(o) => !o && cancelConfirm()} width={400} z={70} className="border-devdeck-red-tint">
      <div className="mb-2.5 flex items-center gap-2.5">
        <TriangleAlert size={15} className="text-devdeck-err" />
        <DialogTitle>Delete {confirm ? titleFor(confirm.kind) : ''}</DialogTitle>
      </div>
      <DialogDescription className="mb-5 font-sans text-[12.5px] leading-[1.55] text-devdeck-fg-2">
        {confirm ? bodyFor(confirm.kind, confirm.name, groupAffectedConnections.length) : ''}
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
