/**
 * Ghost pill primitives for the composer's control row — same shape as
 * t3code's `ComposerControl.tsx` (`h-7 min-h-7 gap-1.5 px-2.5`, ghost
 * variant, `size-3.5` chevron), restyled with DevDeck's own `Button` /
 * `Select` and v2 tokens. No t3code colour value crosses over — see the
 * plan's "Styling — take structure from t3code, colours from DevDeck".
 */
import type { ComponentProps } from 'react'
import { ChevronDown } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'

/** Mirrors t3code's `composerControlClassName` in shape, DevDeck tokens in
 *  colour: muted foreground at rest, full foreground on hover, transitions
 *  off (t3code's own choice — a pill fading in/out reads as laggy next to
 *  the send button, which does animate). */
export const composerControlClassName =
  'h-7 min-h-7 gap-1.5 rounded-md px-2 text-[13px] font-normal text-devdeck-fg-2 transition-none hover:bg-devdeck-hover-wash hover:text-devdeck-fg'

/** A single ghost pill — Model, Effort, Interaction mode, or Runtime mode. */
export function ComposerControl({ className, size = 'sm', variant = 'ghost', ...props }: ComponentProps<typeof Button>) {
  return <Button className={cn(composerControlClassName, className)} size={size} variant={variant} {...props} />
}

/** The pill's leading icon — provider mark, effort gauge, mode glyph. */
export function ComposerControlIcon({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', className)} />
}

/** Trailing chevron for a pill that opens a menu — t3code's `size-3.5`. */
export function ComposerControlChevron() {
  return <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-devdeck-fg-2" strokeWidth={2.25} />
}

/** A pill backed by DevDeck's `Select` rather than a plain button — for a
 *  control whose menu is a real list of options. t3code wraps its own
 *  `SelectTrigger` the same way; DevDeck's `Select` has no separate trigger
 *  to reach for, so this restyles the whole component's trigger instead. */
export function ComposerSelectControl({ triggerClassName, ...props }: ComponentProps<typeof Select>) {
  return (
    <Select
      {...props}
      triggerClassName={cn(
        composerControlClassName,
        'w-auto min-w-0 justify-start rounded-md border-transparent bg-transparent',
        triggerClassName,
      )}
    />
  )
}
