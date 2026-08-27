import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMANDS_BY_ID, KEYBINDING_COMMANDS } from './catalog'
import { normalizeChord, parseChord } from './chord'
import type { KeyEventLike } from './chord'
import {
  KEYBINDINGS_STORAGE_KEY,
  __resetKeybindingsForTests,
  chordsFor,
  findConflicts,
  keybindingOverrides,
  matchesBinding,
  resetAllKeybindings,
  resetKeybinding,
  sanitize,
  setKeybinding,
  subscribeKeybindings,
  terminalEscapeChords,
} from './store'

function press(key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }
}

beforeEach(() => {
  localStorage.clear()
  __resetKeybindingsForTests()
})

describe('catalog integrity', () => {
  it('has a unique id per command', () => {
    const ids = KEYBINDING_COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('ships only parseable, already-normalized defaults', () => {
    for (const command of KEYBINDING_COMMANDS) {
      expect(command.defaults.length, `${command.id} has no default`).toBeGreaterThan(0)
      for (const chord of command.defaults) {
        expect(parseChord(chord), `${command.id}: ${chord}`).not.toBeNull()
        expect(normalizeChord(chord), `${command.id}: ${chord}`).toBe(chord)
      }
    }
  })

  it('ships no same-scope collisions — the conflict banner starts clean', () => {
    const bindings = Object.fromEntries(KEYBINDING_COMMANDS.map((c) => [c.id, c.defaults]))
    expect(findConflicts(bindings)).toEqual({})
  })

  it('describes every command, so the settings table has no blank rows', () => {
    for (const command of KEYBINDING_COMMANDS) {
      expect(command.label.length, command.id).toBeGreaterThan(0)
      expect(command.description.length, command.id).toBeGreaterThan(0)
    }
  })
})

describe('matchesBinding', () => {
  it('fires on the shipped default', () => {
    expect(matchesBinding(press('k', { metaKey: true }), 'workspace.commandPalette')).toBe(true)
  })

  it('follows a rebind on the next keypress, with no remount', () => {
    setKeybinding('workspace.commandPalette', ['mod+alt+j'])
    expect(matchesBinding(press('k', { metaKey: true }), 'workspace.commandPalette')).toBe(false)
    expect(matchesBinding(press('j', { metaKey: true, altKey: true }), 'workspace.commandPalette')).toBe(true)
  })

  it('matches any of a command’s chords', () => {
    expect(matchesBinding(press('Delete'), 'explorer.deleteSelection')).toBe(true)
    expect(matchesBinding(press('Backspace'), 'explorer.deleteSelection')).toBe(true)
  })

  it('goes silent when a command is unbound', () => {
    setKeybinding('editor.save', [])
    expect(chordsFor('editor.save')).toEqual([])
    expect(matchesBinding(press('s', { metaKey: true }), 'editor.save')).toBe(false)
  })

  it('returns false for an id no longer in the catalog', () => {
    expect(matchesBinding(press('k', { metaKey: true }), 'gone.away')).toBe(false)
  })

  it('suppresses a modifier-free chord while a text field has focus', () => {
    const input = document.createElement('input')
    expect(matchesBinding({ ...press('Delete'), target: input }, 'explorer.deleteSelection')).toBe(false)
    expect(matchesBinding({ ...press('Delete'), target: document.createElement('div') }, 'explorer.deleteSelection')).toBe(
      true,
    )
  })

  it('leaves modifier chords alone in a text field — Cmd+S still saves while typing', () => {
    const textarea = document.createElement('textarea')
    expect(matchesBinding({ ...press('s', { metaKey: true }), target: textarea }, 'editor.save')).toBe(true)
  })
})

describe('persistence', () => {
  it('stores only what differs from the defaults', () => {
    setKeybinding('editor.save', ['mod+alt+s'])
    expect(JSON.parse(localStorage.getItem(KEYBINDINGS_STORAGE_KEY) ?? '{}')).toEqual({ 'editor.save': ['mod+alt+s'] })
  })

  it('drops the override when a rebind lands back on the default', () => {
    setKeybinding('editor.save', ['mod+alt+s'])
    setKeybinding('editor.save', ['mod+s'])
    expect(keybindingOverrides()).toEqual({})
    expect(localStorage.getItem(KEYBINDINGS_STORAGE_KEY)).toBeNull()
  })

  it('keeps an explicit unbind, which is not the same as having no override', () => {
    setKeybinding('editor.save', [])
    expect(keybindingOverrides()).toEqual({ 'editor.save': [] })
  })

  it('normalizes and de-duplicates what it is handed', () => {
    setKeybinding('editor.save', ['Mod+Shift+S', 'mod+shift+s'])
    expect(chordsFor('editor.save')).toEqual(['mod+shift+s'])
  })

  it('resets one command and all commands', () => {
    setKeybinding('editor.save', ['mod+alt+s'])
    setKeybinding('explorer.newFile', ['mod+alt+n'])
    resetKeybinding('editor.save')
    expect(chordsFor('editor.save')).toEqual(COMMANDS_BY_ID.get('editor.save')?.defaults)
    resetAllKeybindings()
    expect(keybindingOverrides()).toEqual({})
    expect(chordsFor('explorer.newFile')).toEqual(COMMANDS_BY_ID.get('explorer.newFile')?.defaults)
  })

  it('notifies subscribers so the settings table repaints', () => {
    const listener = vi.fn()
    subscribeKeybindings(listener)
    setKeybinding('editor.save', ['mod+alt+s'])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]['editor.save']).toEqual(['mod+alt+s'])
  })
})

describe('sanitize', () => {
  it('drops rows for commands this build no longer has', () => {
    expect(sanitize({ 'editor.save': ['mod+s'], 'retired.command': ['mod+q'] })).toEqual({ 'editor.save': ['mod+s'] })
  })

  it('drops unparseable and non-string chords rather than failing the whole read', () => {
    expect(sanitize({ 'editor.save': ['mod+s', 'mod', 42, null] })).toEqual({ 'editor.save': ['mod+s'] })
  })

  it('ignores a value that is not an object of arrays', () => {
    expect(sanitize(null)).toEqual({})
    expect(sanitize(['mod+s'])).toEqual({})
    expect(sanitize({ 'editor.save': 'mod+s' })).toEqual({})
  })
})

describe('findConflicts', () => {
  it('flags two commands sharing a chord inside one scope', () => {
    const conflicts = findConflicts({ 'editor.save': ['mod+s'], 'explorer.newFile': ['mod+n'] })
    expect(conflicts).toEqual({})

    setKeybinding('explorer.newFile', ['mod+n'])
    const clashing = findConflicts({ 'explorer.newFile': ['mod+x'], 'explorer.deleteSelection': ['mod+x'] })
    expect(clashing['explorer.newFile']).toEqual([COMMANDS_BY_ID.get('explorer.deleteSelection')?.label])
    expect(clashing['explorer.deleteSelection']).toEqual([COMMANDS_BY_ID.get('explorer.newFile')?.label])
  })

  it('leaves cross-scope repeats alone — Cmd+S saves a file and stashes a prompt by design', () => {
    expect(findConflicts({ 'editor.save': ['mod+s'], 'chat.stashPrompt': ['mod+s'] })).toEqual({})
  })
})

describe('terminalEscapeChords', () => {
  it('lists the chords xterm must hand back', () => {
    expect(terminalEscapeChords().sort()).toEqual(['mod+k', 'mod+p'])
  })

  it('follows a rebind, so a moved palette chord is still not eaten by the shell', () => {
    setKeybinding('workspace.commandPalette', ['mod+alt+j'])
    expect(terminalEscapeChords()).toContain('mod+alt+j')
    expect(terminalEscapeChords()).not.toContain('mod+k')
  })
})
