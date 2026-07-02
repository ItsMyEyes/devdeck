import { SpawnDialog } from './SpawnDialog'
import { NewProjectDialog } from './NewProjectDialog'
import { NewWorkspaceDialog } from './NewWorkspaceDialog'
import { FolderBrowser } from './FolderBrowser'
import { EditDrawer } from './EditDrawer'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'

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
    </>
  )
}
