import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

interface StatusDotProps {
  color: string
  pulse?: boolean
  size?: number
  className?: string
  style?: CSSProperties
}

/**
 * The pulsing status dot used throughout loom (cards, tree, drawer, breadcrumb).
 * Ports the mockup's `dot(color, pulse)` helper — a colored disc with a soft
 * ring, optionally breathing.
 */
export function StatusDot({ color, pulse = false, size = 8, className, style }: StatusDotProps) {
  return (
    <span
      className={cn('inline-block shrink-0 rounded-full', className)}
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: pulse ? `0 0 0 3px ${color}22, 0 0 9px ${color}77` : `0 0 0 2px ${color}1f`,
        animation: pulse ? 'var(--animate-pulse-dot)' : 'none',
        ...style,
      }}
    />
  )
}
