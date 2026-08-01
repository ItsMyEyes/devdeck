import { describe, expect, it, vi } from 'vitest'
import { APP_PAGES, entityItems } from '@/features/palette/providers/entities'
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
    projects: [{ id: 'p1', name: 'acme/api', machineId: 'm1' }],
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
    const items = entityItems(sources({ projects: [{ id: 'x', name: 'p', machineId: 'x' }], machines: [{ id: 'x', name: 'm' }] }), actions)
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
})
