/**
 * Ported from t3code's `apps/web/src/components/chat/ComposerBannerStack.tsx`
 * (spec `2026-08-15-composer-banner-stack-design.md` Design §1) — same
 * priority stack, the same two-phase-dismiss animation, structurally intact.
 * `items[0]` is the front banner and is always visible; everything behind it
 * collapses to a 12px card edge that expands on hover or focus.
 *
 * `ComposerBanner` (the row) replaces t3code's `Alert`-based row: this repo
 * has exactly one consumer, so the children-sniffing indirection `Alert`
 * uses to find its title/description/action slots earns nothing here (spec
 * Design §2) — icon/title/description/actions are explicit props instead.
 * `alert-glass` is not ported by name; the equivalent translucent surface is
 * `bg-devdeck-glass` + `--devdeck-glass-filter` (`globals.css:42-46`), which
 * already degrades to solid under `prefers-reduced-transparency`
 * (`globals.css:371-377`) — it composes fine with a tone's own translucent
 * tint background, since `backdrop-filter` blurs whatever is *behind* the
 * element regardless of the element's own (semi-transparent) fill.
 *
 * Two deliberate deviations from the reference (spec Design §3):
 *  - keyboard reachability: once `items.length > 1`, the stack root takes
 *    `tabIndex={0}` and a counting `aria-label`. The stacked items are
 *    `invisible` (and so unfocusable) until the group is hover-or-focus-
 *    within, and F's highest-priority banner (connection) is never
 *    dismissible or actionable — without this, a keyboard-only user could
 *    never open the stack at all.
 *  - `role` follows tone: `alert` (assertive) only for `tone: 'error'`,
 *    `status` (polite) for everything else — t3code hardcodes `role="alert"`
 *    on every banner, which would fire an interruption for every tone at
 *    once during a reconnect.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export type ComposerBannerTone = 'default' | 'warning' | 'error' | 'info'

export interface ComposerBannerStackItem {
  readonly id: string
  readonly tone: ComposerBannerTone
  readonly icon: ReactNode
  readonly title: ReactNode
  readonly description?: ReactNode
  /** Dormant in F (spec Design §6) — the slot later B/A banners queue
   *  behind. Nothing in this subsystem populates it. */
  readonly actions?: ReactNode
  readonly className?: string
  /** Dormant alongside `actions`. */
  readonly actionClassName?: string
  readonly dismissLabel?: string
  /** Absent ⇒ not dismissible (F1, the connection banner). */
  readonly onDismiss?: () => void
}

interface ComposerBannerStackProps {
  readonly className?: string
  readonly items: ReadonlyArray<ComposerBannerStackItem>
}

const DISMISS_TRANSITION_MS = 220

const restingStyle = {
  opacity: 1,
  transform: 'none',
} satisfies CSSProperties
const frontExitStyle = {
  opacity: 0,
  transform: 'translate3d(0, 4rem, 0)',
} satisfies CSSProperties
const stackedExitStyle = {
  opacity: 0,
  transform: 'translate3d(0, 7rem, 0)',
} satisfies CSSProperties
const exitTransitionStyle = {
  transition: `transform ${DISMISS_TRANSITION_MS}ms ease-in, opacity ${DISMISS_TRANSITION_MS}ms ease-in`,
} satisfies CSSProperties

export function ComposerBannerStack({ className, items }: ComposerBannerStackProps) {
  const [requestedExitingItemId, setExitingItemId] = useState<string | null>(null)
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Derived, not read from state directly: state ∩ items. If the parent
  // removes a banner mid-exit — because its underlying condition went false
  // on its own, independent of the dismiss animation — this falls back to
  // null instead of leaving the stack permanently `pointer-events-none`.
  const exitingItemId =
    requestedExitingItemId !== null && items.some((item) => item.id === requestedExitingItemId)
      ? requestedExitingItemId
      : null

  useEffect(() => {
    return () => {
      if (dismissTimeoutRef.current) clearTimeout(dismissTimeoutRef.current)
    }
  }, [])

  if (items.length === 0) return null

  const frontItem = items[0]
  if (!frontItem) return null
  const stackedItems = items.slice(1)
  const hasStack = stackedItems.length > 0
  const showCollapsedStackCap = hasStack && exitingItemId !== frontItem.id

  function requestDismiss(item: ComposerBannerStackItem) {
    // One dismissal at a time, and only while the item is still live.
    if (!item.onDismiss || exitingItemId) return
    setExitingItemId(item.id)
    if (dismissTimeoutRef.current) clearTimeout(dismissTimeoutRef.current)
    dismissTimeoutRef.current = setTimeout(() => {
      dismissTimeoutRef.current = null
      item.onDismiss?.()
    }, DISMISS_TRANSITION_MS)
  }

  const keyboardReachable = items.length > 1

  return (
    <div
      className={cn('group/banner-stack mx-auto mb-2 max-w-3xl', className)}
      tabIndex={keyboardReachable ? 0 : -1}
      aria-label={keyboardReachable ? `${items.length} banners, use arrow keys or hover to reveal` : undefined}
    >
      <div
        className={cn(
          'relative flex flex-col-reverse',
          hasStack ? 'group-hover/banner-stack:z-50 group-focus-within/banner-stack:z-50' : null,
        )}
      >
        {showCollapsedStackCap ? (
          <div
            data-composer-banner-stack-cap="true"
            className={cn(
              'pointer-events-none absolute inset-x-0 -top-3 z-0 mx-auto h-3 rounded-t-[22px]',
              'border border-b-0 border-devdeck-hairline bg-devdeck-raised shadow-[0_6px_18px_rgba(0,0,0,0.06)]',
              'transition-opacity duration-150 ease-out',
              'group-hover/banner-stack:opacity-0 group-focus-within/banner-stack:opacity-0',
            )}
            style={{ width: '96%' }}
            aria-hidden="true"
          />
        ) : null}
        <div
          data-banner-id={frontItem.id}
          className={cn('relative z-10', exitingItemId === frontItem.id ? 'pointer-events-none' : null)}
          style={{
            ...exitTransitionStyle,
            ...(exitingItemId === frontItem.id ? frontExitStyle : restingStyle),
          }}
        >
          <ComposerBanner
            item={frontItem}
            exiting={exitingItemId === frontItem.id}
            onDismissRequest={() => requestDismiss(frontItem)}
          />
        </div>
        {hasStack ? (
          <div
            data-composer-banner-stack-expanded-items="true"
            className={cn(
              'relative z-20 grid grid-rows-[0fr] transition-[grid-template-rows] duration-150 ease-out',
              'group-hover/banner-stack:grid-rows-[1fr] group-focus-within/banner-stack:grid-rows-[1fr]',
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div
                className={cn(
                  'invisible pointer-events-none space-y-2 pb-2 opacity-0',
                  'translate-y-1 transform-gpu transition-[opacity,transform] duration-150 ease-out will-change-[opacity,transform]',
                  'group-hover/banner-stack:visible group-hover/banner-stack:pointer-events-auto group-hover/banner-stack:translate-y-0 group-hover/banner-stack:opacity-100',
                  'group-focus-within/banner-stack:visible group-focus-within/banner-stack:pointer-events-auto group-focus-within/banner-stack:translate-y-0 group-focus-within/banner-stack:opacity-100',
                )}
              >
                {stackedItems.map((item) => (
                  <div
                    key={item.id}
                    data-banner-id={item.id}
                    className={cn(exitingItemId === item.id ? 'pointer-events-none' : null)}
                    style={{
                      ...exitTransitionStyle,
                      ...(exitingItemId === item.id ? stackedExitStyle : restingStyle),
                    }}
                  >
                    <ComposerBanner
                      item={item}
                      exiting={exitingItemId === item.id}
                      onDismissRequest={() => requestDismiss(item)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// Tones map to existing DevDeck tokens, not new ones (spec Design §2):
// `error` → `devdeck-red-tint*`, `warning` → `devdeck-yellow-tint*`, `info`
// → `devdeck-accent-tint`, `default` → `devdeck-raised` + `devdeck-hairline`.
// `success` is deliberately absent from the tone union — nothing in F
// produces one.
const TONE_SURFACE: Record<ComposerBannerTone, string> = {
  default: 'border-devdeck-hairline bg-devdeck-raised',
  warning: 'border-devdeck-yellow-tint-border bg-devdeck-yellow-tint',
  error: 'border-devdeck-red-tint-strong-border bg-devdeck-red-tint',
  info: 'border-devdeck-border-accent bg-devdeck-accent-tint',
}

const TONE_TEXT: Record<ComposerBannerTone, string> = {
  default: 'text-devdeck-fg',
  warning: 'text-devdeck-yellow-tint-text',
  error: 'text-devdeck-err',
  info: 'text-devdeck-accent',
}

/** The plain three-column row: icon / (title + description) / actions, all
 *  explicit props rather than sniffed from `children` (spec Design §2). Prop
 *  names (`icon`, `title`, `description`, `actions`) match a real `Alert`'s
 *  slots on purpose, so one could be dropped in later without touching a
 *  caller. */
function ComposerBanner({
  item,
  exiting,
  onDismissRequest,
}: {
  readonly item: ComposerBannerStackItem
  readonly exiting: boolean
  readonly onDismissRequest: () => void
}) {
  const dismissible = Boolean(item.onDismiss)
  // Kept even though nothing in F populates `actions` (spec Design §6) — the
  // dormant seam later subsystems (B/A) queue behind.
  const hasTrailing = Boolean(item.actions) || dismissible
  const role = item.tone === 'error' ? 'alert' : 'status'

  return (
    <div
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      data-tone={item.tone}
      className={cn(
        'flex items-start gap-3 rounded-[22px] border px-4 py-3 [backdrop-filter:var(--devdeck-glass-filter)]',
        TONE_SURFACE[item.tone],
        TONE_TEXT[item.tone],
        item.className,
      )}
    >
      <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center [&>svg]:size-4">{item.icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{item.title}</div>
        {item.description ? <div className="mt-0.5 text-[12.5px] leading-relaxed opacity-80">{item.description}</div> : null}
      </div>
      {hasTrailing ? (
        <div className={cn('flex shrink-0 items-center gap-1', item.actionClassName)}>
          {item.actions}
          {dismissible ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={item.dismissLabel ?? 'Dismiss'}
              disabled={exiting}
              onClick={onDismissRequest}
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
