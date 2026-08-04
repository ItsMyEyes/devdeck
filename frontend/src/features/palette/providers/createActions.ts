import { MODULE_ICON, PROJECT_ICON } from '@/features/tabs/tabIcons'
import { projectFacets } from '@/features/palette/providers/projectFacets'
import type { PaletteItem, PalettePage } from '@/features/palette/paletteTypes'

export interface CreateActionDeps {
  query: string
  machines: { id: string; name: string }[]
  projects: { id: string; name: string; machineId: string; path: string }[]
  sshConnections: { id: string; name: string; host: string; user: string }[]
  offlineMachineIds: Set<string>
  openBrowser: (machineId: string) => void
  openSSHConnection: (connectionId: string) => void
  openSSHQuickAdd: (prefillRaw: string) => void
  openSpawn: (projectId: string) => void
}

/** The project rows behind both "New Agent…" (the drill-down page) and the
 *  `agent-new <arg>` verb. `idPrefix` keeps the two surfaces' row ids — and
 *  therefore their frecency entries and `aria-activedescendant` targets —
 *  distinct. */
export function agentProjectRows(deps: CreateActionDeps, idPrefix: string): PaletteItem[] {
  return deps.projects.map((project) => {
    const facets = projectFacets(project, deps.machines)
    return {
      id: `${idPrefix}:${project.id}`,
      kind: 'project',
      group: 'results',
      title: project.name,
      subtitle: facets.subtitle,
      keywords: facets.keywords,
      literalKeywords: facets.literalKeywords,
      icon: PROJECT_ICON,
      disabled: deps.offlineMachineIds.has(project.machineId) ? { reason: 'Machine is offline' } : undefined,
      run: () => deps.openSpawn(project.id),
    }
  })
}

function machinePage(deps: CreateActionDeps): PalettePage {
  return {
    id: 'create-browser',
    breadcrumb: 'New Browser tab',
    placeholder: 'Choose a machine…',
    items: () =>
      deps.machines.map((machine) => ({
        id: `create-browser:${machine.id}`,
        kind: 'machine',
        group: 'results',
        title: machine.name,
        icon: MODULE_ICON.machines,
        disabled: deps.offlineMachineIds.has(machine.id) ? { reason: 'Machine is offline' } : undefined,
        run: () => deps.openBrowser(machine.id),
      })),
  }
}

function sshPage(deps: CreateActionDeps): PalettePage {
  return {
    id: 'create-ssh',
    breadcrumb: 'New SSH',
    placeholder: 'Search saved hosts, or paste an ssh command…',
    items: () => [
      ...deps.sshConnections.map<PaletteItem>((connection) => ({
        id: `create-ssh:${connection.id}`,
        kind: 'ssh-host',
        group: 'results',
        title: connection.name,
        subtitle: `${connection.user}@${connection.host}`,
        keywords: [connection.host, connection.user],
        icon: MODULE_ICON.ssh,
        run: () => deps.openSSHConnection(connection.id),
      })),
      {
        id: 'create-ssh:new',
        kind: 'create',
        group: 'create',
        title: 'New host from ssh command…',
        icon: MODULE_ICON.ssh,
        run: () => deps.openSSHQuickAdd(''),
      },
    ],
  }
}

function spawnPage(deps: CreateActionDeps): PalettePage {
  return {
    id: 'create-agent',
    breadcrumb: 'New Agent',
    placeholder: 'Choose a project…',
    items: () => agentProjectRows(deps, 'create-agent'),
  }
}

/**
 * The always-present Create rows.
 *
 * These are never filtered by the query (see `rankPaletteItems`) — the query
 * is often the *name of the thing being created*, which by definition may
 * collide with something that already exists.
 */
export function createActionItems(deps: CreateActionDeps): PaletteItem[] {
  return [
    {
      id: 'create:browser',
      kind: 'create',
      group: 'create',
      title: 'New Browser tab',
      icon: MODULE_ICON.browser,
      drillInto: () => machinePage(deps),
    },
    {
      id: 'create:ssh',
      kind: 'create',
      group: 'create',
      title: 'New SSH…',
      icon: MODULE_ICON.ssh,
      drillInto: () => sshPage(deps),
    },
    {
      id: 'create:agent',
      kind: 'create',
      group: 'create',
      title: 'New Agent…',
      icon: MODULE_ICON.agents,
      drillInto: () => spawnPage(deps),
    },
  ]
}
