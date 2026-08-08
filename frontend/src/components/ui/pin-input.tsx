import * as React from 'react'
import { cn } from '@/lib/utils'
import { backspaceAt, PIN_LENGTH, pasteAt, typeAt, type PinEdit } from './pinEdit'

export { PIN_LENGTH } from './pinEdit'

interface PinInputProps {
  value: string
  onChange: (value: string) => void
  /** Fired once the last digit lands, so a sign-in form can submit without a click. */
  onComplete?: (value: string) => void
  disabled?: boolean
  autoFocus?: boolean
  /** Red ring + aria-invalid on every box; clear it as soon as the operator edits. */
  invalid?: boolean
  /** Labels the group for screen readers, e.g. "Sign-in PIN". */
  label: string
  className?: string
}

/**
 * Six single-character boxes that behave like one field: typing advances,
 * Backspace on an empty box steps back, arrows move, and a pasted code fills
 * everything at once (phones autofill an SMS-style code as one paste, so
 * per-box handling alone would drop five of the six digits).
 *
 * The editing rules themselves live in pinEdit.ts — this component is the DOM
 * wiring around them.
 *
 * inputMode="numeric" gets the numeric keypad on mobile without type="number",
 * which would add spinners and accept "e"/"-".
 */
export function PinInput({
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus,
  invalid,
  label,
  className,
}: PinInputProps) {
  const refs = React.useRef<(HTMLInputElement | null)[]>([])
  const digits = Array.from({ length: PIN_LENGTH }, (_, i) => value[i] ?? '')

  function focusBox(index: number) {
    const el = refs.current[Math.max(0, Math.min(PIN_LENGTH - 1, index))]
    el?.focus()
    el?.select()
  }

  function commit(edit: PinEdit) {
    onChange(edit.value)
    focusBox(edit.focus)
    // Passed explicitly: `value` is still a render behind at this point, so a
    // parent that auto-submits on complete cannot read it from state yet.
    if (edit.value.length === PIN_LENGTH) onComplete?.(edit.value)
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      const edit = backspaceAt(value, index)
      if (edit) {
        e.preventDefault()
        commit(edit)
      }
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      focusBox(index - 1)
      return
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      focusBox(index + 1)
    }
  }

  return (
    <div role="group" aria-label={label} className={cn('flex items-center gap-2', className)}>
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          value={digit}
          onChange={(e) => commit(typeAt(value, i, e.target.value))}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={(e) => {
            const edit = pasteAt(value, i, e.clipboardData.getData('text'))
            if (edit) {
              e.preventDefault()
              commit(edit)
            }
          }}
          onFocus={(e) => e.target.select()}
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={PIN_LENGTH}
          aria-label={`${label} digit ${i + 1} of ${PIN_LENGTH}`}
          aria-invalid={invalid || undefined}
          className={cn(
            'h-12 w-full min-w-0 rounded-lg border bg-devdeck-pane text-center font-mono text-[18px] text-devdeck-fg',
            'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            'disabled:opacity-50',
            invalid
              ? 'border-devdeck-err focus-visible:border-devdeck-err'
              : 'border-devdeck-border-strong focus-visible:border-devdeck-border-accent',
          )}
        />
      ))}
    </div>
  )
}
