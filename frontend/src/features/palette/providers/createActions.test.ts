import { describe, expect, it, vi } from 'vitest'
import { agentProjectRows, createActionItems } from '@/features/palette/providers/createActions'
import type { CreateActionDeps } from '@/features/palette/providers/createActions'
import { MODULE_ICON, PROJECT_ICON } from '@/features/tabs/tabIcons'
import type { PaletteRunContext } from '@/features/palette/paletteTypes'

const ctx: PaletteRunContext = { wsId: 'ws1', leafId: 'leaf-a', showToast: () => {}, close: () => {} }

function deps(overrides: Partial<CreateActionDeps> = {}): CreateActionDeps {
  return {
    query: '',
    machines: [{ id: 'm1', name: 'mac-studio' }],
    projects: [{ id: 'p1', name: 'acme/api', machineId: 'm1', path: '~/Documents/freelance/acme/api' }],
    sshConnections: [{ id: 'c1', name: 'prod-db', host: '10.1.1.4', user: 'root' }],
    offlineMachineIds: new Set<string>(),
    openBrowser: vi.fn(),
    openSSHConnection: vi.fn(),
    openSSHQuickAdd: vi.fn(),
    openSpawn: vi.fn(),
    ...overrides,
  }
}

describe('agentProjectRows', () => {
  it('emits subtitle/keywords/literalKeywords from projectFacets and honours the idPrefix', () => {
    const rows = agentProjectRows(deps(), 'command:agent-new')
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row.id).toBe('command:agent-new:p1')
    expect(row.subtitle).toBe('mac-studio · …/acme/api')
    expect(row.keywords).toEqual(['mac-studio'])
    expect(row.literalKeywords).toEqual(['~/Documents/freelance/acme/api'])
  })

  it('disables rows whose machine is offline', () => {
    const rows = agentProjectRows(deps({ offlineMachineIds: new Set(['m1']) }), 'create-agent')
    expect(rows[0].disabled).toEqual({ reason: 'Machine is offline' })
  })
})

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

  // Row ids are frecency keys — the "New Agent…" page must keep the
  // 'create-agent' prefix so previously-recorded frecency entries still
  // resolve to a row after this delegates to `agentProjectRows`.
  it("still yields create-agent:<projectId> ids and disables rows whose machine is offline", () => {
    const items = createActionItems(deps({ offlineMachineIds: new Set(['m1']) }))
    const projectRows = items.find((i) => i.id === 'create:agent')!.drillInto!().items('', ctx)
    expect(projectRows.map((i) => i.id)).toEqual(['create-agent:p1'])
    expect(projectRows[0].disabled).toEqual({ reason: 'Machine is offline' })
  })
})
