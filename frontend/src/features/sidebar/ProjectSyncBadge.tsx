import { CloudUpload, TriangleAlert } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import type { Project } from '@/store/types'

/**
 * Only rendered on a runtime (a hub's own projects are always origin="hub").
 * Distinguishes "created here, hasn't replayed yet" from "will never replay
 * as-is" — both look identical as plain rows otherwise, and the second one
 * silently retries forever unless the operator notices and recreates the
 * project under a workspace that still exists.
 */
export function ProjectSyncBadge({ project }: { project: Project }) {
  if (project.origin !== 'local') return null

  if (project.syncError) {
    return (
      <Tooltip label={project.syncError}>
        <TriangleAlert size={12} strokeWidth={2} className="shrink-0 text-devdeck-err" />
      </Tooltip>
    )
  }
  return (
    <Tooltip label="Created on this runtime, not yet synced to the hub">
      <CloudUpload size={12} strokeWidth={2} className="shrink-0 text-devdeck-fg-2" />
    </Tooltip>
  )
}
