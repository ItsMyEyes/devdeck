import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/** How long the bar takes to fade out once loading ends. Must match the
 *  `duration-[180ms]` on the element below. */
const FADE_MS = 180

export interface ProgressLineProps {
  active: boolean
  /** Grace period before the bar appears. Cache-served navigations resolve in
   *  a frame or two; without this the bar flashes once and reads as a glitch
   *  rather than as progress (design spec §4.1). */
  delayMs?: number
  className?: string
}

type Phase = 'hidden' | 'visible' | 'leaving'

/** Indeterminate 2px progress line. Indeterminate by necessity, not by
 *  preference: the native webview bridge reports only `loading: boolean`, so a
 *  determinate bar would be inventing a percentage. Absolutely positioned —
 *  the caller supplies a `relative` ancestor. */
export function ProgressLine({ active, delayMs = 150, className }: ProgressLineProps) {
  const [phase, setPhase] = useState<Phase>('hidden')

  // One effect, keyed on `phase` as well as `active`: the leaving branch
  // re-arms its own timer after the `setPhase('leaving')` re-render clears it,
  // which two separate effects could not do without a ref.
  useEffect(() => {
    if (active) {
      if (phase === 'visible') return
      const timer = setTimeout(() => setPhase('visible'), delayMs)
      return () => clearTimeout(timer)
    }
    if (phase === 'hidden') return
    const timer = setTimeout(() => setPhase('hidden'), FADE_MS)
    if (phase !== 'leaving') setPhase('leaving')
    return () => clearTimeout(timer)
  }, [active, delayMs, phase])

  if (phase === 'hidden') return null

  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      aria-busy={phase === 'visible'}
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 z-10 h-0.5 overflow-hidden',
        'transition-opacity duration-[180ms] ease-out',
        phase === 'leaving' ? 'opacity-0' : 'opacity-100',
        className,
      )}
    >
      <span
        className="animate-progress-slide block h-full w-[30%] rounded-full"
        style={{ background: 'var(--devdeck-accent-gradient)' }}
      />
    </div>
  )
}
