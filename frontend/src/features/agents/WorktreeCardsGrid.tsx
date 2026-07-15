import type { Project } from '@/store/types'
import { WorkspaceHostsView } from './WorkspaceHostsView'

export function WorktreeCardsGrid({ project, wsId }: { project: Project; wsId: string }) {
  return <WorkspaceHostsView wsId={wsId} projects={[project]} selectedProjectId={project.id} />
}
