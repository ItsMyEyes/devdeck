import type { ReactNode } from 'react'

/** Shared top bar for the workspace modules (matches the agents breadcrumb rhythm). */
export function ModuleHeader({
  title,
  meta,
  actions,
}: {
  title: string
  meta?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex min-h-12 flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-devdeck-border px-4 py-2.5">
      <span className="whitespace-nowrap text-[13px] font-semibold text-devdeck-fg-2">{title}</span>
      {meta ? <span className="whitespace-nowrap font-mono text-[11px] text-devdeck-dim">{meta}</span> : null}
      <div className="min-w-2 flex-1" />
      {actions}
    </div>
  )
}
