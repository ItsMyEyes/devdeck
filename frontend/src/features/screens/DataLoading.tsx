import { Loader2 } from 'lucide-react'

/** Lightweight loading state for server-backed data. */
export function DataLoading({ label }: { label?: string }) {
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3 font-mono text-[13px] text-loom-dim">
        <Loader2 size={22} strokeWidth={1.5} className="animate-spin text-loom-dim-2" />
        <span>{label ?? 'loading…'}</span>
      </div>
    </div>
  )
}
