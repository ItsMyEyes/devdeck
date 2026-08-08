import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium ' +
    'transition-colors cursor-pointer select-none disabled:pointer-events-none disabled:opacity-50 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 font-sans shrink-0',
  {
    variants: {
      variant: {
        /** devdeck-blue primary CTA */
        default: 'bg-primary text-primary-foreground font-semibold hover:bg-devdeck-accent-hover',
        /** Accent, but subordinate to `default`. For an action that is important
         *  and app-level, yet is NOT the action the current screen is about —
         *  the global "+ Worktree" next to a module's own CTA. Keeps the accent
         *  identity without a second saturated fill competing on the page.
         *  Matches the treatment "New agent" already uses. */
        'accent-soft':
          'bg-devdeck-accent-tint text-devdeck-accent font-semibold border border-devdeck-border-accent hover:bg-devdeck-accent-tint-hover',
        /** hairline outline — the workhorse toolbar button */
        secondary:
          'bg-transparent text-devdeck-fg-2 border border-devdeck-border-menu hover:bg-devdeck-glass-solid hover:text-devdeck-fg',
        ghost: 'bg-transparent text-devdeck-fg-2 hover:bg-white/[0.04] hover:text-devdeck-fg',
        /** toggled/active state (e.g. a panel that is currently open) — the
         *  one state wash, not an accent tint. */
        soft: 'bg-devdeck-on text-devdeck-fg border border-devdeck-line hover:bg-devdeck-hover-wash',
        /** approve / warning */
        warning: 'bg-devdeck-yellow text-devdeck-warning-ink font-semibold hover:bg-devdeck-wait',
        /** merge / success */
        success: 'bg-devdeck-green-tint text-devdeck-run border border-devdeck-green-tint-border hover:bg-devdeck-green-tint-hover',
        /** destructive outline (kill / delete) */
        destructive: 'bg-transparent text-devdeck-err border border-devdeck-red-tint hover:bg-devdeck-red-tint-hover',
        /** solid destructive (confirm delete) */
        'destructive-solid':
          'bg-devdeck-red-tint-strong text-devdeck-red-tint-strong-text font-semibold border border-devdeck-red-tint-strong-border hover:bg-devdeck-red-tint-strong-hover',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs',
        default: 'h-8 px-3 text-[12.5px]',
        lg: 'h-9 px-3.5 text-[12.5px]',
        xl: 'h-10 px-4 text-[13px]',
        icon: 'h-8 w-8 p-0',
        'icon-sm': 'h-7 w-7 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
)
Button.displayName = 'Button'

export { buttonVariants }
