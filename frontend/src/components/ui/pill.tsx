import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface PillProps {
  color: string
  children: ReactNode
  weight?: number
  className?: string
  style?: CSSProperties
}

/**
 * Tinted status pill (worktree state, invoice status, priority, news tag).
 * Derives fill/border from a single accent color, matching the mockup's
 * `color+'18'` / `color+'33'` convention.
 */
export function Pill({ color, children, weight = 500, className, style }: PillProps) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center whitespace-nowrap rounded-md font-mono text-[10px]', className)}
      style={{
        color,
        background: `${color}18`,
        border: `1px solid ${color}33`,
        fontWeight: weight,
        padding: '3px 8px',
        ...style,
      }}
    >
      {children}
    </span>
  )
}
