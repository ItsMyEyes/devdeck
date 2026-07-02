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
        /** loom-blue primary CTA */
        default: 'bg-primary text-primary-foreground font-semibold hover:bg-loom-accent-hover',
        /** hairline outline — the workhorse toolbar button */
        secondary:
          'bg-transparent text-loom-muted border border-loom-border-menu hover:bg-loom-popover hover:text-loom-fg',
        ghost: 'bg-transparent text-loom-muted hover:bg-white/[0.04] hover:text-loom-fg',
        /** blue-tinted (e.g. terminal "Send") */
        soft: 'bg-loom-accent-tint text-loom-accent-soft border border-loom-border-accent hover:bg-loom-accent-tint-hover',
        /** approve / warning */
        warning: 'bg-loom-yellow text-loom-warning-ink font-semibold hover:bg-loom-yellow-soft',
        /** merge / success */
        success: 'bg-loom-green-tint text-loom-green-soft border border-loom-green-tint-border hover:bg-loom-green-tint-hover',
        /** destructive outline (kill / delete) */
        destructive: 'bg-transparent text-loom-red-soft border border-loom-red-tint hover:bg-loom-red-tint-hover',
        /** solid destructive (confirm delete) */
        'destructive-solid':
          'bg-loom-red-tint-strong text-loom-red-tint-strong-text font-semibold border border-loom-red-tint-strong-border hover:bg-loom-red-tint-strong-hover',
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
