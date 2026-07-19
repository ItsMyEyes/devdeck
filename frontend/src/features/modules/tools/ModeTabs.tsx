import { cn } from '@/lib/utils'

/** Small pill-style tab switch — reused by tools with an Encode/Decode or similar two-way mode. */
export function ModeTabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="flex flex-none items-center gap-0.5 rounded-md border border-devdeck-border-menu p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'cursor-pointer rounded px-2.5 py-1 font-mono text-[11px] transition-colors',
            value === o.value ? 'bg-devdeck-accent/10 text-devdeck-fg' : 'text-devdeck-muted hover:text-devdeck-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
