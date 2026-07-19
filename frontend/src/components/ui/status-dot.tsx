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
        boxShadow: `0 0 0 2px ${color}1f`,
        ...style,
      }}
    />
  )
}
