import { SpawnDialog } from './SpawnDialog'
import { NewProjectDialog } from './NewProjectDialog'
import { NewWorkspaceDialog } from './NewWorkspaceDialog'
import { FolderBrowser } from './FolderBrowser'
import { EditDrawer } from './EditDrawer'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
import { ConfirmMachineActionDialog } from './ConfirmMachineActionDialog'
import { TransferStatusPanel } from './TransferStatusPanel'
import { DesktopSettingsDialog } from './DesktopSettingsDialog'
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
      <ConfirmMachineActionDialog />
      <TransferStatusPanel />
      <DesktopSettingsDialog />
      <MachineDialog />
      <SSHConnectionDialog />
      <RenameSSHGroupDialog />
    </>
  )
}
