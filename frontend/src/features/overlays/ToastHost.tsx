import { useEffect, useId } from 'react'
import { CircleAlert, CircleCheck, Info, Loader2, TriangleAlert } from 'lucide-react'
import { Toaster, useSonner } from 'sonner'
import type { OverlayBlockerRect } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { useResolvedTheme } from '@/features/theme/useTheme'

/** Toasts are UI chrome floating over the app, so they get the glass material
 *  and a hairline edge rather than a coloured ring: the type is carried by the
 *  icon, which is the one part of a toast the eye lands on first. Only an error
 *  also tints its border — the one message you must not miss in peripheral
 *  vision. Everything is `unstyled` because sonner injects its own stylesheet at
 *  runtime, outside our cascade layers, where it would beat every utility class
 *  no matter how specific (its `[data-description]` colour is a hardcoded
 *  `#3f3f3f`, unreadable on a dark surface). */
const TOAST_CLASSES = {
  toast:
    'flex w-full items-start gap-2.5 rounded-control border border-devdeck-border-menu bg-devdeck-glass px-3.5 py-3 font-sans text-[12.5px] leading-[1.45] shadow-[0_18px_44px_-16px_rgba(0,0,0,0.7)] [backdrop-filter:var(--devdeck-glass-filter)]',
  error: 'border-devdeck-err/35',
  // `relative` is load-bearing, not decoration: sonner wraps a custom loading
  // icon in a `.sonner-loader` that positions itself absolutely at 50%/50%, so
  // without a positioned icon box the spinner escapes and lands in the middle of
  // the card. Sonner's own styles put `position: relative` here; `unstyled`
  // drops it.
  icon: 'relative mt-px flex h-4 w-4 flex-none items-center justify-center [&_svg]:h-4 [&_svg]:w-4',
  content: 'flex min-w-0 flex-1 flex-col gap-0.5',
  title: 'font-medium text-devdeck-fg',
  description: 'text-[11.5px] leading-relaxed text-devdeck-fg-2',
  actionButton:
    'ml-auto flex-none cursor-pointer rounded-sm bg-devdeck-accent px-2 py-1 text-[11.5px] font-medium text-devdeck-accent-ink transition-colors hover:bg-devdeck-accent-hover',
  cancelButton:
    'flex-none cursor-pointer rounded-sm px-2 py-1 text-[11.5px] text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
} as const

const TOAST_ICONS = {
  success: <CircleCheck className="text-devdeck-run" />,
  error: <CircleAlert className="text-devdeck-err" />,
  warning: <TriangleAlert className="text-devdeck-wait" />,
  info: <Info className="text-devdeck-accent" />,
  loading: <Loader2 className="animate-spin text-devdeck-fg-2" />,
} as const

function unionRect(elements: Element[]): OverlayBlockerRect | null {
  if (elements.length === 0) return null
  const rects = elements.map((element) => element.getBoundingClientRect())
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  }
}

function sameRect(a: OverlayBlockerRect | null, b: OverlayBlockerRect | null): boolean {
  if (!a || !b) return a === b
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom
}

/**
 * Keeps a Browser tile's native webview from swallowing the toasts.
 *
 * That webview is an OS surface stacked above the entire app DOM, so no
 * `z-index` can put a toast in front of one — which is why toasts used to sit at
 * top-center, out of a tile's way. Pushing a rect-scoped blocker instead means
 * `visibleTileRect` cuts the webview back to the largest rectangle the toast
 * stack does not cover, so the page stays on screen (a 356px corner card leaves
 * far more than the 50% floor) and the toast is actually visible.
 *
 * Measured per frame, not from a ResizeObserver: sonner moves toasts with CSS
 * transforms, which change neither the element's border-box size nor fire scroll
 * or resize events. Same reason `useNativeOverlayBlocker`'s `live` mode exists —
 * this cannot use that hook directly because sonner's `<ol>` is a zero-height
 * box holding absolutely positioned children, so the region has to come from the
 * union of the toasts themselves.
 */
function useToastOcclusionBlocker(active: boolean) {
  const push = useDevDeckStore((s) => s.pushNativeOverlayBlocker)
  const pop = useDevDeckStore((s) => s.popNativeOverlayBlocker)
  const id = useId()

  useEffect(() => {
    if (!active) return
    let held: OverlayBlockerRect | null = null

    const measure = () => {
      const region = unionRect([
        ...document.querySelectorAll('[data-sonner-toast][data-visible="true"]'),
      ])
      if (sameRect(held, region)) return
      held = region
      // Every frame of an enter/exit animation reports a new rect; writing an
      // unchanged one would re-render every store subscriber for nothing.
      if (region) push(id, region)
      else pop(id)
    }

    let frame = requestAnimationFrame(function tick() {
      measure()
      frame = requestAnimationFrame(tick)
    })
    return () => {
      cancelAnimationFrame(frame)
      pop(id)
    }
  }, [active, push, pop, id])
}

/** The app's single toast surface. Wraps sonner's `Toaster` so the occlusion
 *  blocker can be tied to "are there toasts on screen right now". */
export function ToastHost() {
  const { toasts } = useSonner()
  const resolvedTheme = useResolvedTheme()
  useToastOcclusionBlocker(toasts.length > 0)

  return (
    <Toaster
      theme={resolvedTheme}
      position="bottom-right"
      offset={16}
      // Lifted above the on-screen keyboard. A toast is `position: fixed`
      // against the LAYOUT viewport, which mobile browsers don't shrink when the
      // keyboard opens — so a bottom-anchored toast would hide behind it, and
      // this app is used from a phone with the keyboard up (MobileKeyToolbar).
      // `--app-height` is the visual viewport (see globals.css), so the
      // difference from `100dvh` is exactly the keyboard, and zero without it.
      mobileOffset={{
        bottom: 'calc(100dvh - var(--app-height) + 12px)',
        left: 12,
        right: 12,
        top: 12,
      }}
      gap={10}
      visibleToasts={4}
      icons={TOAST_ICONS}
      toastOptions={{ unstyled: true, classNames: TOAST_CLASSES }}
    />
  )
}
