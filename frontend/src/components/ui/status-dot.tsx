import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

interface StatusDotProps {
  color: string
  size?: number
  className?: string
  style?: CSSProperties
}

/** Static colored status dot used throughout DevDeck (cards, tree, drawer, breadcrumb). */
export function StatusDot({ color, size = 8, className, style }: StatusDotProps) {
  return (
    <span
      className={cn('inline-block shrink-0 rounded-full', className)}
      style={{
        width: size,
        height: size,
        background: color,
        // `color-mix` (not string-suffix concatenation) so this tolerates any
        // valid CSS <color> input — a hex literal or a `var(--devdeck-*)`
        // reference. `${color}1f` only produced a valid color when `color`
        // was already a hex literal; appended straight after a var() call it
        // tokenizes as a stray dimension and the whole box-shadow drops.
        boxShadow: `0 0 0 2px color-mix(in srgb, ${color} 12%, transparent)`,
        ...style,
      }}
    />
  )
}
