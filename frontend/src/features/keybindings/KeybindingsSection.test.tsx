import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { KEYBINDING_COMMANDS } from './catalog'
import { setMacPlatformForTests } from './chord'
import { KeybindingsSection } from './KeybindingsSection'
import { __resetKeybindingsForTests, chordsFor, keybindingOverrides } from './store'

/** The row whose command label matches, so assertions read off one command. */
function rowFor(label: string): HTMLElement {
  const heading = screen.getByText(label)
  const row = heading.closest('.group\\/row')
  if (!(row instanceof HTMLElement)) throw new Error(`no row for "${label}"`)
  return row
}

beforeEach(() => {
  localStorage.clear()
  __resetKeybindingsForTests()
  // Pin the platform so pill assertions don't depend on the host running them.
  setMacPlatformForTests(false)
})

afterEach(() => {
  cleanup()
  setMacPlatformForTests(null)
})

describe('KeybindingsSection', () => {
  it('lists every command in the catalog', () => {
    render(<KeybindingsSection />)
    for (const command of KEYBINDING_COMMANDS) {
      expect(screen.getByText(command.label), command.id).toBeInTheDocument()
    }
  })

  it('shows each command’s current chord as keycaps', () => {
    render(<KeybindingsSection />)
    const row = rowFor('Open command palette')
    expect(within(row).getByText('Ctrl')).toBeInTheDocument()
    expect(within(row).getByText('K')).toBeInTheDocument()
  })

  it('renders both chords of a multi-chord command', () => {
    render(<KeybindingsSection />)
    const row = rowFor('Delete selection')
    expect(within(row).getByText('Del')).toBeInTheDocument()
    expect(within(row).getByText('⌫')).toBeInTheDocument()
  })

  it('filters by command name and by the keys themselves', () => {
    render(<KeybindingsSection />)
    const search = screen.getByLabelText('Search keybindings')

    fireEvent.change(search, { target: { value: 'zoom' } })
    expect(screen.getByText('Zoom in')).toBeInTheDocument()
    expect(screen.queryByText('Open command palette')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'ctrl k' } })
    expect(screen.getByText('Open command palette')).toBeInTheDocument()
    expect(screen.queryByText('Zoom in')).not.toBeInTheDocument()
  })

  it('explains an empty search rather than showing a blank pane', () => {
    render(<KeybindingsSection />)
    fireEvent.change(screen.getByLabelText('Search keybindings'), { target: { value: 'zzzz' } })
    expect(screen.getByText(/No shortcut matches/)).toBeInTheDocument()
  })

  it('rebinds a command from a recorded keypress', () => {
    render(<KeybindingsSection />)
    fireEvent.click(screen.getByLabelText('Add a shortcut for Save file'))
    expect(screen.getByText('Press a shortcut…')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'j', metaKey: true, altKey: true })

    // Recording started in `add` mode because the command already had a chord.
    expect(chordsFor('editor.save')).toEqual(['mod+s', 'mod+alt+j'])
    expect(screen.queryByText('Press a shortcut…')).not.toBeInTheDocument()
  })

  it('stays armed through a lone modifier, so holding Cmd first still works', () => {
    render(<KeybindingsSection />)
    fireEvent.click(screen.getByLabelText('Add a shortcut for Save file'))

    fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
    expect(chordsFor('editor.save')).toEqual(['mod+s'])

    fireEvent.keyDown(window, { key: 'j', metaKey: true })
    expect(chordsFor('editor.save')).toEqual(['mod+s', 'mod+j'])
  })

  it('cancels recording on Escape without changing anything', () => {
    render(<KeybindingsSection />)
    fireEvent.click(screen.getByLabelText('Add a shortcut for Save file'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('Press a shortcut…')).not.toBeInTheDocument()
    expect(keybindingOverrides()).toEqual({})
  })

  it('records into an empty command as a replacement, not an append', () => {
    render(<KeybindingsSection />)
    fireEvent.click(within(rowFor('Save file')).getByLabelText('Remove Ctrl+S'))
    expect(chordsFor('editor.save')).toEqual([])

    fireEvent.click(screen.getByLabelText('Set shortcut for Save file'))
    fireEvent.keyDown(window, { key: 'j', metaKey: true })
    expect(chordsFor('editor.save')).toEqual(['mod+j'])
  })

  it('removes a single chord from a multi-chord command', () => {
    render(<KeybindingsSection />)
    fireEvent.click(within(rowFor('Delete selection')).getByLabelText('Remove Backspace'))
    expect(chordsFor('explorer.deleteSelection')).toEqual(['delete'])
  })

  it('marks a customized row and resets it on demand', () => {
    render(<KeybindingsSection />)
    const resetOne = screen.getByLabelText('Reset Save file to default')
    expect(resetOne).toBeDisabled()

    fireEvent.click(screen.getByLabelText('Add a shortcut for Save file'))
    fireEvent.keyDown(window, { key: 'j', metaKey: true })

    expect(within(rowFor('Save file')).getByText('custom')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Reset Save file to default'))
    expect(chordsFor('editor.save')).toEqual(['mod+s'])
    expect(within(rowFor('Save file')).queryByText('custom')).not.toBeInTheDocument()
  })

  it('resets everything at once, and says so when there is nothing to reset', () => {
    render(<KeybindingsSection />)
    const resetAll = screen.getByRole('button', { name: /Reset all/ })
    expect(resetAll).toBeDisabled()

    fireEvent.click(screen.getByLabelText('Add a shortcut for Save file'))
    fireEvent.keyDown(window, { key: 'j', metaKey: true })
    expect(screen.getByText(/1 shortcut customized/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Reset all/ }))
    expect(keybindingOverrides()).toEqual({})
    expect(screen.getByText(/All shortcuts are at their shipped defaults/)).toBeInTheDocument()
  })

  it('warns when a rebind collides with another command in the same scope', () => {
    render(<KeybindingsSection />)
    expect(screen.queryByText(/Same shortcut as/)).not.toBeInTheDocument()

    // Toggle git panel onto the chord Toggle file explorer already holds.
    fireEvent.click(screen.getByLabelText('Add a shortcut for Toggle git panel'))
    fireEvent.keyDown(window, { key: 'e', metaKey: true })

    expect(within(rowFor('Toggle git panel')).getByText(/Same shortcut as Toggle file explorer/)).toBeInTheDocument()
    expect(within(rowFor('Toggle file explorer')).getByText(/Same shortcut as Toggle git panel/)).toBeInTheDocument()
  })
})
