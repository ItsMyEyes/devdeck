import * as React from 'react'
import { cn } from '@/lib/utils'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-lg border border-loom-border-strong bg-loom-bg px-2.5 text-[12.5px] text-loom-fg',
        'font-sans placeholder:text-loom-dim-2 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-loom-border-accent',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
