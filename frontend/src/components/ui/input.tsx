import * as React from 'react'
import { cn } from '@/lib/utils'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-lg border border-devdeck-border-strong bg-devdeck-pane px-2.5 text-[12.5px] text-devdeck-fg',
        'font-sans placeholder:text-devdeck-fg-2 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-devdeck-border-accent',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
