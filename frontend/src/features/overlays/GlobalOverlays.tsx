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
import { RuntimePinDialog } from '@/features/machines/RuntimePinDialog'
import { SSHConnectionDialog } from '@/features/ssh/SSHConnectionDialog'
import { RenameSSHGroupDialog } from '@/features/ssh/RenameSSHGroupDialog'
import { UpdateBanner } from '@/features/updates/UpdateBanner'
import { useThemeSync } from '@/features/theme/useTheme'

/** All portal-rendered overlays, driven by the store's UI state. */
export function GlobalOverlays() {
  // Mounted here because this component is always rendered: it owns the
  // <html> class/color-scheme sync and the OS listener behind "follow system".
  useThemeSync()
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
      {/* Renders nothing outside the desktop shell, and nothing inside it
          until an update has been downloaded and staged. */}
      <UpdateBanner />
      <DesktopSettingsDialog />
      <MachineDialog />
      <RuntimePinDialog />
      <SSHConnectionDialog />
      <RenameSSHGroupDialog />
    </>
  )
}
