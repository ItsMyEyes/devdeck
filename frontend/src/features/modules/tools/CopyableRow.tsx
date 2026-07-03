import { Copy } from 'lucide-react'
import { toast } from 'sonner'

/** Read-only label/value row with a one-click copy button — used for hashes, UUIDs, JWT parts, etc. */
export function CopyableRow({ label, value }: { label: string; value: string }) {
  function copy() {
    if (!value) return
    void navigator.clipboard.writeText(value)
    toast.success(`${label} copied`)
  }

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-loom-border-card bg-loom-terminal px-2.5 py-2">
      <span className="w-16 flex-none font-mono text-[10px] tracking-wide text-loom-dim uppercase">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-loom-fg">{value || '—'}</span>
      <button
        type="button"
        onClick={copy}
        disabled={!value}
        aria-label={`Copy ${label}`}
        className="flex-none cursor-pointer p-1 text-loom-muted-2 hover:text-loom-accent-soft disabled:pointer-events-none disabled:opacity-40"
      >
        <Copy size={12} />
      </button>
    </div>
  )
}
