import { afterEach, describe, expect, it } from 'vitest'
import {
  chordFromEvent,
  chordLabel,
  chordMatchesEvent,
  chordTokens,
  normalizeChord,
  parseChord,
  setMacPlatformForTests,
} from './chord'
import type { KeyEventLike } from './chord'

function press(key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }
}

afterEach(() => setMacPlatformForTests(null))

describe('parseChord', () => {
  it('reads modifiers and the key', () => {
    expect(parseChord('mod+shift+f')).toMatchObject({ mod: true, shift: true, alt: false, key: 'f' })
  })

  it('accepts cmd/command/control/option spellings', () => {
    expect(parseChord('cmd+k')).toMatchObject({ meta: true, key: 'k' })
    expect(parseChord('control+k')).toMatchObject({ ctrl: true, key: 'k' })
    expect(parseChord('option+k')).toMatchObject({ alt: true, key: 'k' })
  })

  it('accepts a modifier-free key', () => {
    expect(parseChord('delete')).toMatchObject({ mod: false, key: 'delete' })
  })

  it('rejects a lone modifier — nothing to fire on', () => {
    expect(parseChord('mod')).toBeNull()
    expect(parseChord('shift')).toBeNull()
    expect(parseChord('')).toBeNull()
  })

  it('folds keycaps that share a physical key, so one chord covers both', () => {
    expect(parseChord('mod++')).toMatchObject({ key: '=' })
    expect(parseChord('mod+_')).toMatchObject({ key: '-' })
  })

  it('normalizes to a canonical modifier order', () => {
    expect(normalizeChord('SHIFT+Mod+F')).toBe('mod+shift+f')
    // A dangling separator leaves no key behind.
    expect(normalizeChord('mod+')).toBeNull()
  })

  it('does not police key names — `event.key` is an open vocabulary', () => {
    expect(parseChord('mod+f13')).toMatchObject({ mod: true, key: 'f13' })
    expect(parseChord('audiovolumeup')).toMatchObject({ key: 'audiovolumeup' })
  })
})

describe('chordMatchesEvent', () => {
  it('treats `mod` as Cmd *or* Ctrl, matching what the old inline handlers did', () => {
    expect(chordMatchesEvent('mod+k', press('k', { metaKey: true }))).toBe(true)
    expect(chordMatchesEvent('mod+k', press('k', { ctrlKey: true }))).toBe(true)
    expect(chordMatchesEvent('mod+k', press('k'))).toBe(false)
  })

  it('honours a deliberately Cmd-only binding', () => {
    // Ctrl+[ is Escape to every terminal, which is why Next/Prev tab ship as meta.
    expect(chordMatchesEvent('meta+[', press('[', { metaKey: true }))).toBe(true)
    expect(chordMatchesEvent('meta+[', press('[', { ctrlKey: true }))).toBe(false)
  })

  it('matches modifiers exactly in both directions', () => {
    expect(chordMatchesEvent('mod+p', press('p', { metaKey: true, shiftKey: true }))).toBe(false)
    expect(chordMatchesEvent('mod+p', press('p', { metaKey: true, altKey: true }))).toBe(false)
    expect(chordMatchesEvent('mod+shift+f', press('F', { metaKey: true, shiftKey: true }))).toBe(true)
  })

  it('ignores Shift for keys on a shifted keycap, so Cmd++ still zooms in', () => {
    expect(chordMatchesEvent('mod+=', press('+', { metaKey: true, shiftKey: true }), true)).toBe(true)
    expect(chordMatchesEvent('mod+=', press('+', { metaKey: true, shiftKey: true }))).toBe(false)
  })

  it('is case-insensitive about the key', () => {
    expect(chordMatchesEvent('mod+k', press('K', { metaKey: true }))).toBe(true)
  })

  it('returns false for an unparseable chord instead of throwing', () => {
    expect(chordMatchesEvent('mod', press('k', { metaKey: true }))).toBe(false)
  })
})

describe('chordFromEvent', () => {
  it('records Cmd and Ctrl alike as `mod`, so a rebind survives the other platform', () => {
    expect(chordFromEvent(press('K', { metaKey: true }))).toBe('mod+k')
    expect(chordFromEvent(press('k', { ctrlKey: true }))).toBe('mod+k')
  })

  it('keeps Alt and Shift distinct', () => {
    expect(chordFromEvent(press('f', { metaKey: true, altKey: true, shiftKey: true }))).toBe('mod+alt+shift+f')
  })

  it('returns null for a lone modifier so the recorder stays armed', () => {
    expect(chordFromEvent(press('Meta', { metaKey: true }))).toBeNull()
    expect(chordFromEvent(press('Shift', { shiftKey: true }))).toBeNull()
  })

  it('allows a modifier-free chord — the file explorer ships one', () => {
    expect(chordFromEvent(press('Delete'))).toBe('delete')
  })
})

describe('display', () => {
  it('renders macOS glyphs', () => {
    setMacPlatformForTests(true)
    expect(chordTokens('mod+shift+f')).toEqual(['⌘', '⇧', 'F'])
    expect(chordLabel('mod+k')).toBe('⌘K')
  })

  it('renders spelled-out modifiers elsewhere', () => {
    setMacPlatformForTests(false)
    expect(chordTokens('mod+shift+f')).toEqual(['Ctrl', 'Shift', 'F'])
    expect(chordLabel('mod+k')).toBe('Ctrl+K')
  })

  it('names special keys rather than printing raw event values', () => {
    setMacPlatformForTests(false)
    expect(chordTokens('delete')).toEqual(['Del'])
    expect(chordTokens('mod+arrowup')).toEqual(['Ctrl', '↑'])
  })
})
