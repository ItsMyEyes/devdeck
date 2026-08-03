import { describe, expect, it, vi } from 'vitest'
import { createActionItems } from '@/features/palette/providers/createActions'
import type { CreateActionDeps } from '@/features/palette/providers/createActions'
import { MODULE_ICON, PROJECT_ICON } from '@/features/tabs/tabIcons'
import type { PaletteRunContext } from '@/features/palette/paletteTypes'

const ctx: PaletteRunContext = { wsId: 'ws1', leafId: 'leaf-a', showToast: () => {}, close: () => {} }

function deps(overrides: Partial<CreateActionDeps> = {}): CreateActionDeps {
  return {
    query: '',
    machines: [{ id: 'm1', name: 'mac-studio' }],
    projects: [{ id: 'p1', name: 'acme/api', machineId: 'm1' }],
    sshConnections: [{ id: 'c1', name: 'prod-db', host: '10.1.1.4', user: 'root' }],
    offlineMachineIds: new Set<string>(),
    openBrowser: vi.fn(),
    openSSHConnection: vi.fn(),
    openSSHQuickAdd: vi.fn(),
    openSpawn: vi.fn(),
    ...overrides,
  }
}

describe('createActionItems', () => {
  it('gives each Create row the icon of the menu it creates in', () => {
    const items = createActionItems(deps())
    const iconOf = (id: string) => items.find((i) => i.id === id)?.icon
    expect(iconOf('create:browser')).toBe(MODULE_ICON.browser)
    expect(iconOf('create:ssh')).toBe(MODULE_ICON.ssh)
    expect(iconOf('create:agent')).toBe(MODULE_ICON.agents)
  })

  // The drill-in pages are the rows that used to render a blank icon slot:
  // they are the only Results rows not produced by `entityItems`.
  it('gives every row of every drill-in page an icon', () => {
    for (const row of createActionItems(deps())) {
      const page = row.drillInto?.()
      expect(page).toBeDefined()
      const rows = page!.items('', ctx)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((i) => i.icon !== undefined)).toBe(true)
    }
  })

  it('labels the machine picker with the Machines icon and the project picker with a project folder', () => {
    const items = createActionItems(deps())
    const machineRows = items.find((i) => i.id === 'create:browser')!.drillInto!().items('', ctx)
    const projectRows = items.find((i) => i.id === 'create:agent')!.drillInto!().items('', ctx)
    expect(machineRows.map((i) => i.icon)).toEqual([MODULE_ICON.machines])
    expect(projectRows.map((i) => i.icon)).toEqual([PROJECT_ICON])
  })
})
