import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal as XTerm } from '@xterm/xterm'
import { __resetKeybindingsForTests, setKeybinding } from '@/features/keybindings/store'
import { isAppShortcut, terminalKeyEventHandler } from './Terminal'

/**
 * The handler both terminal surfaces install — this file's Terminal and the
 * SSH registry's shared instances.
 *
 * Covers the select-all branch specifically: xterm.js binds nothing for that
 * chord, and the browser's own Select All lands on xterm's hidden
 * one-character helper textarea, so before this the chord looked dead in every
 * terminal in the app.
 */

vi.mock('@/lib/terminalClient', () => ({
  inputFrame: (s: string) => s,
  resizeFrame: () => '',
  terminalWsUrl: () => new Promise(() => {}),
}))

afterEach(() => {
  __resetKeybindingsForTests()
})

function fakeTerm() {
  return { selectAll: vi.fn() } as unknown as XTerm & { selectAll: ReturnType<typeof vi.fn> }
}

function keydown(init: KeyboardEventInit) {
  return new KeyboardEvent('keydown', { cancelable: true, ...init })
}

describe('terminalKeyEventHandler', () => {
  it('selects the whole buffer on the select-all chord and stops xterm handling it', () => {
    const term = fakeTerm()
    const event = keydown({ key: 'a', metaKey: true })

    expect(terminalKeyEventHandler(term)(event)).toBe(false)
    expect(term.selectAll).toHaveBeenCalledTimes(1)
    // Without this WebKit runs its own Select All on xterm's helper textarea
    // straight afterwards, undoing the selection that was just made.
    expect(event.defaultPrevented).toBe(true)
  })

  it('accepts Ctrl as well as Cmd, the way every other `mod` chord does', () => {
    const term = fakeTerm()
    expect(terminalKeyEventHandler(term)(keydown({ key: 'a', ctrlKey: true }))).toBe(false)
    expect(term.selectAll).toHaveBeenCalledTimes(1)
  })

  it('leaves a bare Ctrl-less "a" to the shell', () => {
    const term = fakeTerm()
    expect(terminalKeyEventHandler(term)(keydown({ key: 'a' }))).toBe(true)
    expect(term.selectAll).not.toHaveBeenCalled()
  })

  it('does not fire on keyup, so the chord runs once per press', () => {
    const term = fakeTerm()
    const event = new KeyboardEvent('keyup', { key: 'a', metaKey: true, cancelable: true })
    terminalKeyEventHandler(term)(event)
    expect(term.selectAll).not.toHaveBeenCalled()
  })

  it('still hands app-level chords back to the window', () => {
    const term = fakeTerm()
    // Cmd+K is `escapesTerminal` in the catalog — the palette must open from
    // inside a focused terminal.
    const event = keydown({ key: 'k', metaKey: true })
    expect(isAppShortcut(event)).toBe(true)
    expect(terminalKeyEventHandler(term)(event)).toBe(false)
    expect(term.selectAll).not.toHaveBeenCalled()
  })

  it('follows a rebind rather than hard-coding the chord', () => {
    setKeybinding('terminal.selectAll', ['mod+shift+a'])
    const term = fakeTerm()

    expect(terminalKeyEventHandler(term)(keydown({ key: 'a', metaKey: true }))).toBe(true)
    expect(term.selectAll).not.toHaveBeenCalled()

    expect(terminalKeyEventHandler(term)(keydown({ key: 'a', metaKey: true, shiftKey: true }))).toBe(false)
    expect(term.selectAll).toHaveBeenCalledTimes(1)
  })
})
