import { type ReactNode, useEffect } from 'react'
import { Globe, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useMachines } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'
import type { Project } from '@/store/types'

interface NewTabDialogProps {
  wsId: string
  projects: Project[]
  currentProjectId?: string
  onCreateBrowser: (machineId: string) => void
  onCreateShell: (projectId: string) => void
}

/** The tab strip's "+" chooser: pick Browser or Spawn shell, then a machine
 *  to run it on — required for both kinds, defaulted to the first
 *  registered machine so Create isn't blocked on an empty selection the
 *  moment machines are available. */
export function NewTabDialog({ wsId, projects, currentProjectId, onCreateBrowser, onCreateShell }: NewTabDialogProps) {
  const newTab = useLoomStore((s) => s.newTab)
  const closeNewTab = useLoomStore((s) => s.closeNewTab)
  const setNewTab = useLoomStore((s) => s.setNewTab)
  const machines = useMachines().data ?? []
  const open = newTab.open && newTab.wsId === wsId

  useEffect(() => {
    if (open && !newTab.machineId && machines.length > 0) {
      setNewTab({ machineId: machines[0].id })
    }
  }, [open, newTab.machineId, machines, setNewTab])

  const machineOptions = machines.map((m) => ({ value: m.id, label: m.name }))
  const shellProjects = projects.filter((p) => p.machineId === newTab.machineId)
  const shellProject = shellProjects.find((p) => p.id === currentProjectId) ?? shellProjects[0]
  const canCreate = !!newTab.machineId && (newTab.kind === 'browser' || !!shellProject)

  function submit() {
    if (!canCreate) return
    closeNewTab()
    if (newTab.kind === 'browser') onCreateBrowser(newTab.machineId)
    else if (shellProject) onCreateShell(shellProject.id)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeNewTab()} width={400}>
      <DialogTitle>New tab</DialogTitle>
      <DialogDescription className="mb-4">Choose what to open and which machine to run it on.</DialogDescription>

      <div className="mb-4 flex gap-1.5 rounded-lg border border-loom-border-strong bg-loom-bg p-1">
        <KindTab active={newTab.kind === 'browser'} onClick={() => setNewTab({ kind: 'browser' })}>
          <Globe size={13} />
          Browser
        </KindTab>
        <KindTab active={newTab.kind === 'shell'} onClick={() => setNewTab({ kind: 'shell' })}>
          <TerminalSquare size={13} />
          Spawn shell
        </KindTab>
      </div>

      <div className="mb-5">
        <Label>Machine</Label>
        {machines.length === 0 ? (
          <p className="mt-1 font-mono text-[11px] text-loom-dim">Add a machine first.</p>
        ) : (
          <Select
            value={newTab.machineId}
            onValueChange={(v) => setNewTab({ machineId: v })}
            options={machineOptions}
            aria-label="Machine"
          />
        )}
        {newTab.kind === 'shell' && newTab.machineId && !shellProject ? (
          <p className="mt-1.5 font-mono text-[11px] text-loom-red-soft">No project on this machine yet.</p>
        ) : null}
      </div>

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={closeNewTab}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canCreate}>
          Create →
        </Button>
      </div>
    </Dialog>
  )
}

function KindTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
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
