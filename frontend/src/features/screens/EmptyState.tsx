import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'

/** Shared empty-state primitive: centered dashed-border card with mono muted text. */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode
  title: string
  hint?: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3.5 rounded-[14px] border border-dashed border-loom-border-strong font-mono text-[13px] text-loom-dim">
        {icon ? <div className="text-loom-dim-2">{icon}</div> : null}
        <span>{title}</span>
        {hint ? <span className="text-[12px] text-loom-dim-2">{hint}</span> : null}
        {action ? (
          <Button onClick={action.onClick} className="px-3.5">{action.label}</Button>
        ) : null}
      </div>
    </div>
  )
}
