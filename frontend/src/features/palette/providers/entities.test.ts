import { describe, expect, it, vi } from 'vitest'
import { APP_PAGES, entityItems } from '@/features/palette/providers/entities'
import { MODULE_ICON, PROJECT_ICON, WORKTREE_ICON } from '@/features/tabs/tabIcons'
import type { EntityActions, EntitySources } from '@/features/palette/providers/entities'

const actions: EntityActions = {
  openWorktree: vi.fn(),
  openProject: vi.fn(),
  openSSH: vi.fn(),
  openMachine: vi.fn(),
  openPage: vi.fn(),
}

function sources(overrides: Partial<EntitySources> = {}): EntitySources {
  return {
    wsId: 'ws1',
    worktrees: [{ id: 'wt1', projectId: 'p1', branch: 'feat/palette', name: 'feat/palette' }],
    projects: [{ id: 'p1', name: 'acme/api', machineId: 'm1', path: '~/Documents/freelance/mabes/superapps/core' }],
    sshConnections: [{ id: 'c1', name: 'prod-db', host: '10.1.1.4', user: 'root' }],
    machines: [{ id: 'm1', name: 'mac-studio' }],
    offlineMachineIds: new Set<string>(),
    ...overrides,
  }
}

describe('entityItems', () => {
  it('emits one item per worktree, project, ssh host, machine and page', () => {
    const items = entityItems(sources(), actions)
    const counts = items.reduce<Record<string, number>>((acc, i) => {
      acc[i.kind] = (acc[i.kind] ?? 0) + 1
      return acc
    }, {})
    expect(counts.worktree).toBe(1)
    expect(counts.project).toBe(1)
    expect(counts['ssh-host']).toBe(1)
    expect(counts.machine).toBe(1)
    expect(counts.page).toBe(APP_PAGES.length)
  })

  it('carries each entity the icon of the menu it lives under', () => {
    const items = entityItems(sources(), actions)
    const iconOf = (id: string) => items.find((i) => i.id === id)?.icon
    expect(iconOf('worktree:wt1')).toBe(WORKTREE_ICON)
    expect(iconOf('project:p1')).toBe(PROJECT_ICON)
    expect(iconOf('ssh:c1')).toBe(MODULE_ICON.ssh)
    expect(iconOf('machine:m1')).toBe(MODULE_ICON.machines)
    expect(iconOf('page:ssh')).toBe(MODULE_ICON.ssh)
    expect(iconOf('page:index')).toBe(MODULE_ICON.agents)
    expect(items.every((i) => i.icon !== undefined)).toBe(true)
  })

  it('puts everything in the results group', () => {
    expect(entityItems(sources(), actions).every((i) => i.group === 'results')).toBe(true)
  })

  it('exposes host and user as keywords so an IP finds the host', () => {
    const host = entityItems(sources(), actions).find((i) => i.kind === 'ssh-host')
    expect(host?.keywords).toContain('10.1.1.4')
    expect(host?.keywords).toContain('root')
  })

  it('disables projects whose machine is offline', () => {
    const items = entityItems(sources({ offlineMachineIds: new Set(['m1']) }), actions)
    const project = items.find((i) => i.kind === 'project')
    expect(project?.disabled?.reason).toContain('offline')
  })

  it('disables the offline machine itself', () => {
    const items = entityItems(sources({ offlineMachineIds: new Set(['m1']) }), actions)
    expect(items.find((i) => i.kind === 'machine')?.disabled).toBeDefined()
  })

  it('leaves projects enabled when the machine is online', () => {
    const items = entityItems(sources(), actions)
    expect(items.find((i) => i.kind === 'project')?.disabled).toBeUndefined()
  })

  it('namespaces ids by kind so a project and a machine sharing an id do not collide', () => {
    const items = entityItems(sources({ projects: [{ id: 'x', name: 'p', machineId: 'x', path: '~/x' }], machines: [{ id: 'x', name: 'm' }] }), actions)
    const ids = items.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('returns only pages when every entity list is empty', () => {
    const items = entityItems(
      sources({ worktrees: [], projects: [], sshConnections: [], machines: [] }),
      actions,
    )
    expect(items.every((i) => i.kind === 'page')).toBe(true)
  })

  it('carries the machine name in keywords and the full path in literalKeywords on project rows', () => {
    const project = entityItems(sources(), actions).find((i) => i.kind === 'project')
    expect(project?.keywords).toContain('mac-studio')
    expect(project?.literalKeywords).toEqual(['~/Documents/freelance/mabes/superapps/core'])
  })

  it('carries branch, project name and machine name in keywords, the owning project path in literalKeywords, and a "project · machine" subtitle on worktree rows', () => {
    const worktree = entityItems(sources(), actions).find((i) => i.kind === 'worktree')
    expect(worktree?.keywords).toEqual(['feat/palette', 'acme/api', 'mac-studio'])
    expect(worktree?.literalKeywords).toEqual(['~/Documents/freelance/mabes/superapps/core'])
    expect(worktree?.subtitle).toBe('acme/api · mac-studio')
  })

  it('still produces a worktree row, with no thrown error, when its owning project does not resolve', () => {
    let items: ReturnType<typeof entityItems> = []
    expect(() => {
      items = entityItems(
        sources({ worktrees: [{ id: 'wt-orphan', projectId: 'missing', branch: 'orphan' }], projects: [] }),
        actions,
      )
    }).not.toThrow()
    const worktree = items.find((i) => i.id === 'worktree:wt-orphan')
    expect(worktree).toBeDefined()
    expect(worktree?.subtitle).toBeUndefined()
  })
})
