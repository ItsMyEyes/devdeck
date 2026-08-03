// The editing rules behind PinInput, kept pure so they can be tested without
// a DOM. `value` is always left-packed: box i shows value[i], and a PIN is
// complete at PIN_LENGTH characters.

export const PIN_LENGTH = 6

export interface PinEdit {
  value: string
  /** Box the caret should land in afterwards. Callers clamp to the box range. */
  focus: number
}

/** Strips everything that isn't an ASCII digit and caps at PIN_LENGTH. Used on
 *  every input path because phones, password managers, and autofill all
 *  deliver codes with spaces, dashes, or surrounding prose. */
export function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, PIN_LENGTH)
}

/**
 * Types `raw` into box `index`. Typing over a filled box replaces that digit
 * and keeps the tail, so correcting one digit doesn't wipe the rest. An empty
 * `raw` means the box was cleared, which truncates from there — the same thing
 * repeated Backspace does, rather than leaving a hole in a left-packed value.
 */
export function typeAt(value: string, index: number, raw: string): PinEdit {
  const typed = digitsOnly(raw)
  if (!typed) return { value: value.slice(0, index), focus: index }
  const next = (value.slice(0, index) + typed + value.slice(index + typed.length)).slice(0, PIN_LENGTH)
  return { value: next, focus: index + typed.length }
}

/**
 * Backspace in box `index` when that box is already empty: removes the digit
 * to the left and steps back. Returns null at index 0 or when the box still
 * holds a digit — in both cases the browser's own default is correct.
 */
export function backspaceAt(value: string, index: number): PinEdit | null {
  if (index <= 0 || value[index]) return null
  return { value: value.slice(0, index - 1), focus: index - 1 }
}

/**
 * A paste landing in box `index`. Treated as "here is the whole code from
 * here on", so anything to the right is replaced rather than interleaved —
 * an SMS autofill arrives as one paste of all PIN_LENGTH digits.
 */
export function pasteAt(value: string, index: number, raw: string): PinEdit | null {
  const pasted = digitsOnly(raw)
  if (!pasted) return null
  const next = (value.slice(0, index) + pasted).slice(0, PIN_LENGTH)
  return { value: next, focus: next.length }
}

/** All-same digits (000000) and straight runs (123456, 654321). Mirrors
 *  service.weakPIN on the backend, which is the authority — this only lets the
 *  UI say so before the round trip. */
export function isWeakPin(pin: string): boolean {
  if (pin.length !== PIN_LENGTH) return false
  let same = true
  let up = true
  let down = true
  for (let i = 1; i < pin.length; i++) {
    const delta = pin.charCodeAt(i) - pin.charCodeAt(i - 1)
    if (delta !== 0) same = false
    if (delta !== 1) up = false
    if (delta !== -1) down = false
  }
  return same || up || down
}
