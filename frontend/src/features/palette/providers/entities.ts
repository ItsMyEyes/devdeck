import { MODULE_ICON, PROJECT_ICON, WORKTREE_ICON } from '@/features/tabs/tabIcons'
import type { PaletteItem } from '@/features/palette/paletteTypes'

/** Structural subsets of the domain types — only the fields this provider
 *  reads, so the tests need no full domain fixtures. */
export interface EntitySources {
  wsId: string
  worktrees: { id: string; projectId: string; branch: string; name?: string }[]
  projects: { id: string; name: string; machineId: string }[]
  sshConnections: { id: string; name: string; host: string; user: string }[]
  machines: { id: string; name: string }[]
  offlineMachineIds: Set<string>
}

export interface EntityActions {
  openWorktree: (projectId: string, wtId: string) => void
  openProject: (projectId: string) => void
  openSSH: (connectionId: string) => void
  openMachine: (machineId: string) => void
  openPage: (path: string) => void
}

/**
 * The workspace-scoped routes that exist under `w.$wsId.*` — every one of
 * the spec's page list (Agents, Machines, Database, SSH, Browser, Tools,
 * Issues, Todos, Invoices, News, Management) except **Issues**, which is
 * intentionally excluded: `w.$wsId.p.$projectId.issues.tsx` is nested under
 * a project id, unlike every other entry here, which is a bare `w.$wsId.*`
 * route with no further required params. A project-scoped "jump to Issues"
 * entry would need its own drill-down (pick a project first) and is left
 * for a future pass rather than bolted on here.
 *
 * Every icon comes from `MODULE_ICON` — a page row must carry the same glyph
 * the menu itself shows, never a second one picked here.
 */
export const APP_PAGES = [
  { path: '', label: 'Agents', icon: MODULE_ICON.agents },
  { path: 'machines', label: 'Machines', icon: MODULE_ICON.machines },
  { path: 'database', label: 'Database', icon: MODULE_ICON.database },
  { path: 'ssh', label: 'SSH', icon: MODULE_ICON.ssh },
  { path: 'browser', label: 'Browser', icon: MODULE_ICON.browser },
  { path: 'tools', label: 'Tools', icon: MODULE_ICON.tools },
  { path: 'todos', label: 'Todos', icon: MODULE_ICON.todos },
  { path: 'invoices', label: 'Invoices', icon: MODULE_ICON.invoices },
  { path: 'news', label: 'News', icon: MODULE_ICON.news },
  { path: 'management', label: 'Management', icon: MODULE_ICON.management },
] as const

const OFFLINE = { reason: 'Machine is offline' }

/**
 * Every searchable entity in the active workspace, flattened into rows.
 *
 * Worktrees and projects are workspace-scoped by the caller (it passes the
 * active workspace's lists). Machines and SSH hosts are deliberately global
 * — they are not workspace-scoped in the domain model.
 */
export function entityItems(sources: EntitySources, actions: EntityActions): PaletteItem[] {
  const { offlineMachineIds } = sources
  const projectMachine = new Map(sources.projects.map((p) => [p.id, p.machineId]))
  const items: PaletteItem[] = []

  for (const wt of sources.worktrees) {
    const machineId = projectMachine.get(wt.projectId)
    const project = sources.projects.find((p) => p.id === wt.projectId)
    items.push({
      id: `worktree:${wt.id}`,
      kind: 'worktree',
      group: 'results',
      title: wt.name ?? wt.branch,
      subtitle: project?.name,
      keywords: [wt.branch, project?.name ?? ''].filter(Boolean),
      icon: WORKTREE_ICON,
      disabled: machineId && offlineMachineIds.has(machineId) ? OFFLINE : undefined,
      run: () => actions.openWorktree(wt.projectId, wt.id),
    })
  }

  for (const project of sources.projects) {
    items.push({
      id: `project:${project.id}`,
      kind: 'project',
      group: 'results',
      title: project.name,
      subtitle: sources.machines.find((m) => m.id === project.machineId)?.name,
      icon: PROJECT_ICON,
      disabled: offlineMachineIds.has(project.machineId) ? OFFLINE : undefined,
      run: () => actions.openProject(project.id),
    })
  }

  for (const connection of sources.sshConnections) {
    items.push({
      id: `ssh:${connection.id}`,
      kind: 'ssh-host',
      group: 'results',
      title: connection.name,
      subtitle: `${connection.user}@${connection.host}`,
      keywords: [connection.host, connection.user],
      icon: MODULE_ICON.ssh,
      run: () => actions.openSSH(connection.id),
    })
  }

  for (const machine of sources.machines) {
    items.push({
      id: `machine:${machine.id}`,
      kind: 'machine',
      group: 'results',
      title: machine.name,
      subtitle: offlineMachineIds.has(machine.id) ? 'offline' : 'online',
      icon: MODULE_ICON.machines,
      disabled: offlineMachineIds.has(machine.id) ? OFFLINE : undefined,
      run: () => actions.openMachine(machine.id),
    })
  }

  for (const page of APP_PAGES) {
    items.push({
      id: `page:${page.path || 'index'}`,
      kind: 'page',
      group: 'results',
      title: page.label,
      subtitle: 'page',
      icon: page.icon,
      run: () => actions.openPage(page.path),
    })
  }

  return items
}
