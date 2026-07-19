import type { ReactNode } from 'react'

/** Shared chrome for a Tools-module panel: bordered card + title/description header + body slot. */
export function ToolCard({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-[11px] border border-devdeck-border-card bg-devdeck-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-devdeck-border-card px-3.5 py-2.5">
        <div>
          <div className="text-[12.5px] font-medium text-devdeck-fg">{title}</div>
          <div className="mt-0.5 text-[11px] text-devdeck-muted">{description}</div>
        </div>
        {actions ? <div className="flex flex-none items-center gap-1.5">{actions}</div> : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-3.5">{children}</div>
    </div>
  )
}
