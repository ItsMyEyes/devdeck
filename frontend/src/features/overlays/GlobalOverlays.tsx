import { SpawnDialog } from './SpawnDialog'
import { NewProjectDialog } from './NewProjectDialog'
import { NewWorkspaceDialog } from './NewWorkspaceDialog'
import { FolderBrowser } from './FolderBrowser'
import { EditDrawer } from './EditDrawer'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
import { TransferStatusPanel } from './TransferStatusPanel'
import { MachineDialog } from '@/features/machines/MachineDialog'
import { SSHConnectionDialog } from '@/features/ssh/SSHConnectionDialog'
import { RenameSSHGroupDialog } from '@/features/ssh/RenameSSHGroupDialog'

/** All portal-rendered overlays, driven by the store's UI state. */
export function GlobalOverlays() {
  return (
    <>
      <SpawnDialog />
      <NewProjectDialog />
      <NewWorkspaceDialog />
      <FolderBrowser />
      <EditDrawer />
      <ConfirmDeleteDialog />
      <TransferStatusPanel />
      <MachineDialog />
      <SSHConnectionDialog />
      <RenameSSHGroupDialog />
    </>
  )
}
