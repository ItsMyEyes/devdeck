import { DotLottieReact } from '@lottiefiles/dotlottie-react'
import { cn } from '@/lib/utils'

const LOADING_ANIMATION_SRC = 'https://lottie.host/606f05b0-b006-4006-a256-de83e0791403/5TrZTGyKkz.lottie'

/** Loading state for server-backed content. Default fills a full
 *  page/module section (matches the previous 60vh spinner). `compact` fits
 *  inside a smaller embedded container (a panel, a list, a file pane) —
 *  it fills whatever height the caller's own wrapper already provides. */
export function DataLoading({ label, compact }: { label?: string; compact?: boolean }) {
  const content = (
    <div className={cn('flex flex-col items-center justify-center gap-1.5 font-mono text-loom-dim', compact ? 'text-[11px]' : 'gap-3 text-[13px]')}>
      <DotLottieReact
        src={LOADING_ANIMATION_SRC}
        loop
        autoplay
        style={{ width: compact ? 48 : 88, height: compact ? 48 : 88 }}
      />
      <span>{label ?? 'loading…'}</span>
    </div>
  )

  if (compact) {
    return <div className="flex h-full w-full items-center justify-center">{content}</div>
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="flex h-[60vh] items-center justify-center">{content}</div>
    </div>
  )
}
