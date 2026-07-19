import { useDevDeckStore } from '@/store/useDevDeckStore'
import { EmptyState } from './EmptyState'

/** Agents view for a workspace that has no projects yet. */
export function AgentsEmpty() {
  const openNewProject = useDevDeckStore((s) => s.openNewProject)
  return (
    <EmptyState
      title="no projects in this workspace yet"
      action={{ label: '+ Add project', onClick: openNewProject }}
    />
  )
}
