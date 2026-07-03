import type { PointerEvent, ReactNode } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'

const ESC = '\x1b'
const TAB = '\t'
const CTRL_C = '\x03'
const CTRL_V = '\x16'
const ARROW = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' } as const

// Prevent the tap from stealing focus from xterm's hidden input — otherwise the
// on-screen keyboard closes and the next physical keystroke has nowhere to land.
function holdFocus(e: PointerEvent) {
  e.preventDefault()
}

interface KeyProps {
  label: string
  active?: boolean
  onClick: () => void
  children?: ReactNode
}

function Key({ label, active, onClick, children }: KeyProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={holdFocus}
      onClick={onClick}
      className={cn(
        'flex h-9 min-w-9 flex-none items-center justify-center rounded-md border px-2.5 font-mono text-[12px] transition-colors',
        active
          ? 'border-loom-border-accent bg-loom-accent-tint text-loom-accent-soft'
          : 'border-loom-border-menu bg-transparent text-loom-muted active:bg-loom-popover',
      )}
    >
      {children ?? label}
    </button>
  )
}

interface Props {
  ctrlArmed: boolean
  onToggleCtrl: () => void
  onSend: (data: string) => void
}

/** Touch-friendly key row for mobile browsers, whose keyboards lack Ctrl/Tab/Esc/arrows. */
export function MobileKeyToolbar({ ctrlArmed, onToggleCtrl, onSend }: Props) {
  return (
    <div className="flex flex-none items-center gap-1.5 overflow-x-auto border-t border-loom-border bg-loom-surface px-2 py-1.5 md:hidden">
      <Key label="Esc" onClick={() => onSend(ESC)} />
      <Key label="Tab" onClick={() => onSend(TAB)} />
      {/* Sticky modifier: arm here, then type a letter on the OS keyboard to send Ctrl+letter. */}
      <Key label="Ctrl" active={ctrlArmed} onClick={onToggleCtrl} />
      <Key label="Ctrl+C" onClick={() => onSend(CTRL_C)}>
        ^C
      </Key>
      <Key label="Ctrl+V" onClick={() => onSend(CTRL_V)}>
        ^V
      </Key>
      <div className="mx-1 h-5 w-px flex-none bg-loom-border" />
      <Key label="Left" onClick={() => onSend(ARROW.left)}>
        <ArrowLeft size={14} />
      </Key>
      <Key label="Up" onClick={() => onSend(ARROW.up)}>
        <ArrowUp size={14} />
      </Key>
      <Key label="Down" onClick={() => onSend(ARROW.down)}>
        <ArrowDown size={14} />
      </Key>
      <Key label="Right" onClick={() => onSend(ARROW.right)}>
        <ArrowRight size={14} />
      </Key>
    </div>
  )
}
