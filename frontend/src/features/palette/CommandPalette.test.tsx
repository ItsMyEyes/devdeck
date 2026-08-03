import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { WORKTREE_ICON } from '@/features/tabs/tabIcons'

const alpha = {
  id: 'a',
  kind: 'worktree' as const,
  group: 'results' as const,
  title: 'alpha',
  score: 0,
  ranges: [] as [number, number][],
}

const model = {
  query: '',
  setQuery: vi.fn(),
  groups: [{ group: 'results' as const, label: 'Results', items: [alpha], truncated: 0 }],
  rows: [alpha],
  selectedIndex: 0,
  setSelectedIndex: vi.fn(),
  ghost: '',
  breadcrumbs: [] as string[],
  placeholder: 'Search or create…',
  sshPreview: null as { summary: string; ignored: string[] } | null,
  moveSelection: vi.fn(),
  acceptCompletion: vi.fn(() => false),
  drillIn: vi.fn(() => false),
  drillOut: vi.fn(() => false),
  run: vi.fn(),
}

vi.mock('@/features/palette/useCommandPalette', () => ({
  useCommandPalette: () => model,
}))

const closePalette = vi.fn()
vi.mock('@/store/useDevDeckStore', () => ({
  useDevDeckStore: (selector: (s: unknown) => unknown) =>
    selector({ palette: { open: true, wsId: 'ws1', leafId: 'leaf-a' }, closePalette, showToast: vi.fn() }),
}))

vi.mock('@/features/browser/useNativeOverlayBlocker', () => ({ useNativeOverlayBlocker: () => {} }))

describe('CommandPalette keyboard contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The model is shared across tests; individual tests mutate the display
    // fields, so every one starts from the same baseline.
    model.query = ''
    model.ghost = ''
    model.breadcrumbs = []
    model.sshPreview = null
    model.groups = [{ group: 'results', label: 'Results', items: [alpha], truncated: 0 }]
    model.rows = [alpha]
  })

  it('focuses the input on open', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    expect(await screen.findByRole('combobox')).toHaveFocus()
  })

  it('ArrowDown moves the selection forward', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{ArrowDown}')
    expect(model.moveSelection).toHaveBeenCalledWith(1)
  })

  it('ArrowUp moves the selection backward', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{ArrowUp}')
    expect(model.moveSelection).toHaveBeenCalledWith(-1)
  })

  it('Ctrl+N and Ctrl+P move the selection', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Control>}n{/Control}')
    expect(model.moveSelection).toHaveBeenCalledWith(1)
    await userEvent.keyboard('{Control>}p{/Control}')
    expect(model.moveSelection).toHaveBeenCalledWith(-1)
  })

  it('Ctrl+P and Ctrl+N are prevented so they never reach the global FileQuickOpen binding', async () => {
    const seen: boolean[] = []
    // Only the chord's own key matters — the bare `Control` keydown that
    // `userEvent` sends first is not something the palette claims.
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'p' || event.key === 'n') seen.push(event.defaultPrevented)
    }
    window.addEventListener('keydown', listener)
    try {
      render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
      await userEvent.keyboard('{Control>}p{/Control}')
      await userEvent.keyboard('{Control>}n{/Control}')
    } finally {
      window.removeEventListener('keydown', listener)
    }
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(Boolean)).toBe(true)
  })

  it('Enter runs the selected row', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Enter}')
    expect(model.run).toHaveBeenCalledWith({ forceForm: false })
  })

  it('Shift+Enter forces the form', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    expect(model.run).toHaveBeenCalledWith({ forceForm: true })
  })

  it('Tab accepts the completion before attempting to drill in', async () => {
    model.acceptCompletion.mockReturnValueOnce(true)
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Tab}')
    expect(model.acceptCompletion).toHaveBeenCalled()
    expect(model.drillIn).not.toHaveBeenCalled()
  })

  it('Tab drills in when there is no completion to accept', async () => {
    model.acceptCompletion.mockReturnValueOnce(false)
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Tab}')
    expect(model.drillIn).toHaveBeenCalled()
  })

  it('ArrowRight at the end of the input accepts the completion', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{ArrowRight}')
    expect(model.acceptCompletion).toHaveBeenCalled()
  })

  it('Backspace on an empty input pops a page', async () => {
    model.drillOut.mockReturnValueOnce(true)
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Backspace}')
    expect(model.drillOut).toHaveBeenCalled()
  })

  it('Backspace with text in the input is left to the input', async () => {
    model.query = 'prod'
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Backspace}')
    expect(model.drillOut).not.toHaveBeenCalled()
  })

  it('Escape pops a page when one is open', async () => {
    model.drillOut.mockReturnValueOnce(true)
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Escape}')
    expect(closePalette).not.toHaveBeenCalled()
  })

  it('Escape closes the palette at the root', async () => {
    model.drillOut.mockReturnValueOnce(false)
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Escape}')
    expect(closePalette).toHaveBeenCalled()
  })

  it('never submits the ghost text as part of the value', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    expect(await screen.findByRole('combobox')).toHaveValue('')
  })

  it('renders ghost text in a separate aria-hidden node, never in the input value', async () => {
    model.query = 'ag'
    model.ghost = 'ent-new '
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    const input = await screen.findByRole('combobox')
    expect(input).toHaveValue('ag')
    const ghost = document.querySelector('[data-testid="palette-ghost"]')
    expect(ghost).not.toBeNull()
    expect(ghost).toHaveAttribute('aria-hidden', 'true')
    expect(ghost?.textContent).toBe('agent-new ')
  })
})

describe('CommandPalette rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    model.query = ''
    model.ghost = ''
    model.breadcrumbs = []
    model.sshPreview = null
    model.groups = [{ group: 'results', label: 'Results', items: [alpha], truncated: 0 }]
    model.rows = [alpha]
  })

  it('points aria-activedescendant at the selected row', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    const input = await screen.findByRole('combobox')
    const option = screen.getByRole('option', { name: /alpha/ })
    expect(input).toHaveAttribute('aria-activedescendant', option.id)
  })

  it('marks a disabled row and shows its reason instead of running it', async () => {
    const offline = { ...alpha, id: 'off', title: 'mac-studio', disabled: { reason: 'Machine is offline' } }
    model.groups = [{ group: 'results', label: 'Results', items: [offline], truncated: 0 }]
    model.rows = [offline]
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    const option = await screen.findByRole('option', { name: /mac-studio/ })
    expect(option).toHaveAttribute('aria-disabled', 'true')
    expect(option.textContent).toContain('Machine is offline')
  })

  it('reports how many rows a group dropped', async () => {
    model.groups = [{ group: 'results', label: 'Results', items: [alpha], truncated: 4 }]
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    expect(await screen.findByText('+4 more')).toBeInTheDocument()
  })

  it('renders an explicit empty state when nothing matched', async () => {
    model.groups = []
    model.rows = []
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    expect(await screen.findByText('No matches')).toBeInTheDocument()
  })

  it('renders the ssh preview with its ignored flags', async () => {
    model.sshPreview = { summary: 'root@10.10.10.5:22', ignored: ['-X'] }
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    expect(await screen.findByText('root@10.10.10.5:22')).toBeInTheDocument()
    expect(screen.getByText('· ignored: -X')).toBeInTheDocument()
  })

  it('renders the drill-down breadcrumb trail', async () => {
    model.breadcrumbs = ['New SSH']
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    expect(await screen.findByText('New SSH')).toBeInTheDocument()
  })

  it('paints the row icon a provider gave it', async () => {
    const withIcon = { ...alpha, icon: WORKTREE_ICON }
    model.groups = [{ group: 'results', label: 'Results', items: [withIcon], truncated: 0 }]
    model.rows = [withIcon]
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    const option = await screen.findByRole('option', { name: /alpha/ })
    // The blank 15px spacer the row falls back to has no glyph in it — an
    // `svg` is the only proof the icon actually painted.
    expect(option.querySelector('svg')).not.toBeNull()
  })
})
