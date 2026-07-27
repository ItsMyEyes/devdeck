import type { Project } from '@/store/types'
import { WorkspaceHostsView } from './WorkspaceHostsView'

export function WorktreeCardsGrid({ project, projects, wsId }: { project: Project; projects: Project[]; wsId: string }) {
  return <WorkspaceHostsView wsId={wsId} projects={projects} selectedProjectId={project.id} />
}
