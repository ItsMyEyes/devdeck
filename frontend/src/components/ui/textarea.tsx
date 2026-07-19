import * as React from 'react'
import { cn } from '@/lib/utils'

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full resize-none rounded-lg border border-devdeck-border-strong bg-devdeck-bg px-2.5 py-2.5 text-[12.5px] leading-relaxed text-devdeck-fg',
        'font-sans placeholder:text-devdeck-dim-2 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-devdeck-border-accent',
        className,
      )}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'
