import { Globe, Network, TerminalSquare } from 'lucide-react'
import type { PaletteItem, PalettePage } from '@/features/palette/paletteTypes'

export interface CreateActionDeps {
  query: string
  machines: { id: string; name: string }[]
  projects: { id: string; name: string; machineId: string }[]
  sshConnections: { id: string; name: string; host: string; user: string }[]
  offlineMachineIds: Set<string>
  openBrowser: (machineId: string) => void
  openSSHConnection: (connectionId: string) => void
  openSSHQuickAdd: (prefillRaw: string) => void
  openSpawn: (projectId: string) => void
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
        icon: Network,
        run: () => deps.openSSHConnection(connection.id),
      })),
      {
        id: 'create-ssh:new',
        kind: 'create',
        group: 'create',
        title: 'New host from ssh command…',
        icon: Network,
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
    items: () =>
      deps.projects.map((project) => ({
        id: `create-agent:${project.id}`,
        kind: 'project',
        group: 'results',
        title: project.name,
        disabled: deps.offlineMachineIds.has(project.machineId) ? { reason: 'Machine is offline' } : undefined,
        run: () => deps.openSpawn(project.id),
      })),
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
      icon: Globe,
      drillInto: () => machinePage(deps),
    },
    {
      id: 'create:ssh',
      kind: 'create',
      group: 'create',
      title: 'New SSH…',
      icon: Network,
      drillInto: () => sshPage(deps),
    },
    {
      id: 'create:agent',
      kind: 'create',
      group: 'create',
      title: 'New Agent…',
      icon: TerminalSquare,
      drillInto: () => spawnPage(deps),
    },
  ]
}
