import { FolderPlus } from 'lucide-react'
import { EmptyState } from './EmptyState'

/** Shown when no workspaces exist at all. */
export function WorkspacesEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      icon={<FolderPlus size={26} strokeWidth={1.5} />}
      title="No workspaces yet"
      hint="Create a workspace to get started, or seed demo data."
      action={{ label: '+ Create workspace', onClick: onCreate }}
    />
  )
}
