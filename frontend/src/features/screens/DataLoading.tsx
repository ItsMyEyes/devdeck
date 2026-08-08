import { cn } from '@/lib/utils'

/** Loading state for server-backed content.
 *
 *  Skeleton rows, not a spinner. Two reasons, both practical rather than
 *  stylistic: a skeleton reserves the space the real content will occupy, so
 *  the layout does not jump when the data lands; and it says "a list is
 *  coming" instead of the undifferentiated "something is happening" that a
 *  circular indicator gives.
 *
 *  This replaced a remote Lottie animation. That version fetched its own asset
 *  from a CDN, which meant the loading state could itself fail to load, or
 *  arrive after the data it was covering for.
 *
 *  The prop signature is deliberately unchanged from that version, so all
 *  28-plus existing call sites keep working untouched. Default fills a full
 *  page/module section; `compact` fits inside a smaller embedded container
 *  (a panel, a list, a file pane) and fills whatever height the caller's own
 *  wrapper already provides. */
export function DataLoading({ label, compact }: { label?: string; compact?: boolean }) {
  // Widths vary so the block reads as text rather than as a progress bar. The
  // sequence is fixed, not random, so the skeleton does not reshuffle on each
  // render while a query retries.
  const widths = compact ? [62, 84, 71] : [54, 78, 66, 83, 47, 72]

  const rows = (
    <div className={cn('flex w-full flex-col', compact ? 'gap-2' : 'gap-2.5')} aria-hidden>
      {widths.map((w, i) => (
        <div
          key={i}
          data-skeleton-row
          className={cn(
            'animate-pulse rounded-micro bg-devdeck-hover-wash motion-reduce:animate-none',
            compact ? 'h-2' : 'h-2.5',
          )}
          style={{ width: `${w}%`, animationDelay: `${i * 90}ms` }}
        />
      ))}
    </div>
  )

  const caption = (
    <span
      role="status"
      className={cn('font-mono text-devdeck-fg-2', compact ? 'text-[11px]' : 'text-[12.5px]')}
    >
      {label ?? 'loading…'}
    </span>
  )

  if (compact) {
    return (
      <div className="flex h-full w-full flex-col gap-2.5 p-3">
        {rows}
        {caption}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4 pt-[12vh]">
        {rows}
        {caption}
      </div>
    </div>
  )
}
