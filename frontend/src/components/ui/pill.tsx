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
 * Derives fill/border from a single accent color.
 *
 * `color-mix`, not the `color+'18'` / `color+'33'` suffix concatenation this
 * used to do — same change, and same reason, as `StatusDot`: a suffix only
 * produces a valid colour when `color` is already a hex literal, which forced
 * `lib/constants.ts` to hardcode the palette and left every pill stuck on the
 * dark-tuned value. Against a light surface those pastels sit around 2.4:1.
 * Taking any CSS <color> lets the constants pass `var(--devdeck-run)` and
 * follow the theme.
 */
export function Pill({ color, children, weight = 500, className, style }: PillProps) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center whitespace-nowrap rounded-md font-mono text-[10px]', className)}
      style={{
        color,
        background: `color-mix(in srgb, ${color} 9%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
        fontWeight: weight,
        padding: '3px 8px',
        ...style,
      }}
    >
      {children}
    </span>
  )
}
