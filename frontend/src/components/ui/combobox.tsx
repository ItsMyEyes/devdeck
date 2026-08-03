import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'

interface ComboboxProps {
  value: string
  onChange: (value: string) => void
  options: string[]
  placeholder?: string
  disabled?: boolean
  className?: string
}

/** Freeform text input with a filtered dropdown of existing values. There's
 *  no separate "create" step — typing a value that doesn't match any option
 *  is already a valid value, same as the plain `<Input>` this replaces. The
 *  dropdown is purely for discoverability (pick an existing group instead of
 *  retyping it and risking a typo-forked duplicate). */
export function Combobox({ value, onChange, options, placeholder, disabled, className }: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  useNativeOverlayBlocker(open, popupRef)

  const matches = useMemo(() => {
    const needle = value.trim().toLowerCase()
    return needle ? options.filter((o) => o.toLowerCase().includes(needle)) : options
  }, [value, options])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  function commit(next: string) {
    onChange(next)
    setOpen(false)
    setHighlighted(-1)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setHighlighted((i) => Math.min(i + 1, matches.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter') {
      if (open && highlighted >= 0 && matches[highlighted]) {
        event.preventDefault()
        commit(matches[highlighted])
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      setHighlighted(-1)
    }
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <Input
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setHighlighted(-1)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="font-mono"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && matches.length > 0 ? (
        <div
          ref={popupRef}
          className={cn(
            'absolute left-0 right-0 top-[calc(100%+5px)] z-[100] max-h-[220px] overflow-auto rounded-[11px]',
            'border border-devdeck-border-menu bg-devdeck-popover p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none',
          )}
        >
          {matches.map((option, index) => (
            <button
              type="button"
              key={option}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(option)}
              className={cn(
                'flex h-8 w-full cursor-pointer select-none items-center rounded-md px-2.5 text-left font-mono text-xs text-devdeck-fg-2 outline-none',
                index === highlighted ? 'bg-white/[0.05] text-devdeck-fg' : 'hover:bg-white/[0.05] hover:text-devdeck-fg',
              )}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
