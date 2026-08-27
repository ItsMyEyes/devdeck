/**
 * Chord parsing, matching and display for the keybinding registry.
 *
 * A chord is a normalized lowercase string: modifiers in canonical order
 * (`mod`, `ctrl`, `meta`, `alt`, `shift`) joined to a key by `+` —
 * `mod+shift+f`, `mod+1`, `meta+[`, `delete`.
 *
 * `mod` is deliberately *not* "Cmd on macOS, Ctrl elsewhere". Every hand-rolled
 * handler this registry replaced tested `event.metaKey || event.ctrlKey`, so
 * `mod` matches either one and the rebind carries the app's existing behaviour
 * across unchanged. `meta` and `ctrl` are there for the rare binding that must
 * be one specific key — `meta+[` cycles tabs because Ctrl+[ is Escape to every
 * terminal on the machine.
 */

/** A normalized chord string. Kept as a bare `string` so stored JSON round-trips. */
export type Chord = string

/**
 * The slice of a keypress matching needs.
 *
 * Structural rather than `KeyboardEvent` because not every call site holds a
 * native event — `TerminalExplorer` matches inside a React `onKeyDown`, whose
 * synthetic event carries the same fields but is a different type.
 */
export interface KeyEventLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  target?: EventTarget | null
}

export interface ParsedChord {
  /** Matches Cmd *or* Ctrl — see the module doc. */
  mod: boolean
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** Lowercased `KeyboardEvent.key`, after `aliasKey` folding. */
  key: string
}

/** Modifier order in a normalized chord, and the order pills render in. */
const MODIFIER_ORDER = ['mod', 'ctrl', 'meta', 'alt', 'shift'] as const

/** Keys that never form a chord on their own. */
const BARE_MODIFIERS = new Set(['shift', 'control', 'alt', 'meta', 'capslock', 'dead', 'altgraph', 'os'])

/**
 * Folds keycaps that share a physical key so one binding covers both halves.
 *
 * `Cmd+=` and `Cmd++` are the same keypress with and without Shift, and the
 * browser-zoom handler this replaced accepted all four of `= + - _`. Folding
 * here (rather than storing two chords) keeps "Zoom in" a single rebindable row.
 */
function aliasKey(key: string): string {
  if (key === '+') return '='
  if (key === '_') return '-'
  if (key === ' ') return 'space'
  return key
}

/**
 * Parses are memoized because `matchesBinding` runs the whole catalog against
 * every keystroke the window sees — including ordinary typing. The key space is
 * bounded by the catalog plus whatever the user has bound, so this never grows.
 */
const parseCache = new Map<Chord, ParsedChord | null>()

export function parseChord(chord: Chord): ParsedChord | null {
  const cached = parseCache.get(chord)
  if (cached !== undefined) return cached
  const parsed = parseChordUncached(chord)
  parseCache.set(chord, parsed)
  return parsed
}

/**
 * Splits on `+` while letting `+` itself be the key.
 *
 * `'mod++'.split('+')` yields `['mod', '', '']`, which loses the keypress
 * entirely — so a `+` that follows a separator is taken as a literal instead of
 * a second separator. `'mod+'` (a dangling separator) still tokenizes to just
 * `['mod']`, which the caller rejects for having no key.
 */
function tokenizeChord(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  for (const char of raw) {
    if (char === '+' && current !== '') {
      tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current !== '') tokens.push(current)
  return tokens
}

function parseChordUncached(chord: Chord): ParsedChord | null {
  const parts = tokenizeChord(chord.trim().toLowerCase())
  if (parts.length === 0) return null

  const parsed: ParsedChord = { mod: false, meta: false, ctrl: false, alt: false, shift: false, key: '' }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const isLast = i === parts.length - 1
    if (!isLast || parts.length === 1) {
      if (part === 'mod') { parsed.mod = true; continue }
      if (part === 'ctrl' || part === 'control') { parsed.ctrl = true; continue }
      if (part === 'meta' || part === 'cmd' || part === 'command') { parsed.meta = true; continue }
      if (part === 'alt' || part === 'option') { parsed.alt = true; continue }
      if (part === 'shift') { parsed.shift = true; continue }
    }
    if (!isLast) return null
    parsed.key = aliasKey(part)
  }

  if (!parsed.key || BARE_MODIFIERS.has(parsed.key)) return null
  return parsed
}

/** Canonical string for a parsed chord — the form stored and compared. */
export function formatChordValue(parsed: ParsedChord): Chord {
  const mods = MODIFIER_ORDER.filter((m) => parsed[m])
  return [...mods, parsed.key].join('+')
}

/** Re-serializes a chord through the parser, so equal chords compare equal. */
export function normalizeChord(chord: Chord): Chord | null {
  const parsed = parseChord(chord)
  return parsed ? formatChordValue(parsed) : null
}

/**
 * Builds a chord from a live keypress, for the settings recorder.
 *
 * Returns `null` for a lone modifier — the recorder stays armed so the user can
 * hold Cmd and *then* press the letter, which is how anyone actually types one.
 * A modifier-free chord is allowed (Delete in the file explorer is one), so the
 * caller is what decides whether a bare letter is acceptable.
 */
export function chordFromEvent(event: KeyEventLike): Chord | null {
  const key = aliasKey(event.key.toLowerCase())
  if (!key || BARE_MODIFIERS.has(key)) return null
  return formatChordValue({
    // A recorded Cmd or Ctrl always stores as `mod`: the recorder cannot tell
    // "the user wants Cmd specifically" from "the user is on a Mac", and `mod`
    // is what keeps the binding working on the other platform. The few
    // deliberately meta-only defaults live in the catalog, not here.
    mod: event.metaKey || event.ctrlKey,
    meta: false,
    ctrl: false,
    alt: event.altKey,
    shift: event.shiftKey,
    key,
  })
}

/**
 * Whether `event` fires `chord`.
 *
 * Modifiers are matched *exactly* in both directions — Cmd+Shift+P no longer
 * triggers a Cmd+P binding the way the old hand-rolled `primary && key === 'p'`
 * tests did. That strictness is what makes the conflict column in settings
 * mean anything: two bindings collide only when they genuinely both fire.
 *
 * `looseShift` opts a binding out for keys that live on a shifted keycap, so
 * `mod+=` still catches the Cmd++ half of "Zoom in".
 */
export function chordMatchesEvent(chord: Chord, event: KeyEventLike, looseShift = false): boolean {
  const parsed = parseChord(chord)
  if (!parsed) return false

  if (parsed.mod) {
    if (!event.metaKey && !event.ctrlKey) return false
  } else {
    if (parsed.meta !== event.metaKey) return false
    if (parsed.ctrl !== event.ctrlKey) return false
  }
  if (parsed.alt !== event.altKey) return false
  if (!looseShift && parsed.shift !== event.shiftKey) return false

  return aliasKey(event.key.toLowerCase()) === parsed.key
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform
  return /mac|iphone|ipad|ipod/i.test(platform ?? '')
}

/** Cached: the platform cannot change mid-session, and this is read per rendered pill. */
let macCache: boolean | null = null
function onMac(): boolean {
  if (macCache === null) macCache = isMacPlatform()
  return macCache
}

/** Test seam — resets the platform cache so both branches stay exercisable. */
export function setMacPlatformForTests(value: boolean | null) {
  macCache = value
}

const KEY_LABELS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: 'Enter',
  escape: 'Esc',
  space: 'Space',
  backspace: '⌫',
  delete: 'Del',
  tab: 'Tab',
  pageup: 'PgUp',
  pagedown: 'PgDn',
}

function keyLabel(key: string): string {
  const named = KEY_LABELS[key]
  if (named) return named
  if (/^f\d{1,2}$/.test(key)) return key.toUpperCase()
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)
}

/**
 * Display tokens for a chord, one per pill — `['⌘', '⇧', 'F']` on macOS,
 * `['Ctrl', 'Shift', 'F']` elsewhere.
 */
export function chordTokens(chord: Chord): string[] {
  const parsed = parseChord(chord)
  if (!parsed) return [chord]
  const mac = onMac()
  const tokens: string[] = []
  if (parsed.mod) tokens.push(mac ? '⌘' : 'Ctrl')
  if (parsed.ctrl) tokens.push(mac ? '⌃' : 'Ctrl')
  if (parsed.meta) tokens.push(mac ? '⌘' : 'Win')
  if (parsed.alt) tokens.push(mac ? '⌥' : 'Alt')
  if (parsed.shift) tokens.push(mac ? '⇧' : 'Shift')
  tokens.push(keyLabel(parsed.key))
  return tokens
}

/** Flat display string, for `title` attributes and test assertions. */
export function chordLabel(chord: Chord): string {
  const tokens = chordTokens(chord)
  return onMac() ? tokens.join('') : tokens.join('+')
}

/**
 * Spelled-out name for an `aria-label`.
 *
 * `chordLabel` is built for the eye — on macOS it reads "⌘⇧F", and a screen
 * reader announcing a row of glyphs tells the user nothing. This spells every
 * part in words instead, so "Remove ⌫" becomes "Remove Backspace".
 */
export function chordSpokenLabel(chord: Chord): string {
  const parsed = parseChord(chord)
  if (!parsed) return chord
  const mac = onMac()
  const parts: string[] = []
  if (parsed.mod) parts.push(mac ? 'Command' : 'Ctrl')
  if (parsed.ctrl) parts.push('Control')
  if (parsed.meta) parts.push(mac ? 'Command' : 'Windows')
  if (parsed.alt) parts.push(mac ? 'Option' : 'Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(spokenKeyLabel(parsed.key))
  return parts.join('+')
}

/** Word form of a key name — `keyLabel`'s glyphs are for the eye, not a reader. */
const SPOKEN_KEY_LABELS: Record<string, string> = {
  arrowup: 'Arrow Up',
  arrowdown: 'Arrow Down',
  arrowleft: 'Arrow Left',
  arrowright: 'Arrow Right',
  backspace: 'Backspace',
  delete: 'Delete',
  escape: 'Escape',
  space: 'Space',
  pageup: 'Page Up',
  pagedown: 'Page Down',
}

function spokenKeyLabel(key: string): string {
  const named = SPOKEN_KEY_LABELS[key]
  if (named) return named
  if (key.length === 1) return key.toUpperCase()
  return keyLabel(key)
}
