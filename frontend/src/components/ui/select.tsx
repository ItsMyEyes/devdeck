import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
  /** Item can't be picked — rendered in red (e.g. an offline machine). */
  disabled?: boolean
}

interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  className?: string
  triggerClassName?: string
  disabled?: boolean
  'aria-label'?: string
}

/** Thin wrapper over Base UI Select with the loom menu styling. */
export function Select({ value, onValueChange, options, className, triggerClassName, disabled, ...rest }: SelectProps) {
  return (
    <BaseSelect.Root
      items={options}
      value={value}
      onValueChange={(v) => onValueChange(String(v))}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        aria-label={rest['aria-label']}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-loom-border-strong bg-loom-bg px-2.5',
          'font-mono text-xs text-loom-fg transition-colors select-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:border-loom-border-accent',
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          triggerClassName,
          className,
        )}
      >
        <BaseSelect.Value />
        <BaseSelect.Icon className="text-loom-dim">
          <ChevronDown size={13} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          side="bottom"
          align="start"
          sideOffset={5}
          style={{ zIndex: 100 }}
          className="outline-none"
        >
          <BaseSelect.Popup
            className={cn(
              'min-w-[var(--anchor-width)] origin-[var(--transform-origin)] rounded-[11px] border border-loom-border-menu bg-loom-popover p-1.5',
              'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            )}
          >
            {options.map((o) => (
              <BaseSelect.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className={cn(
                  'flex h-8 cursor-pointer select-none items-center justify-between gap-3 rounded-md px-2.5 font-mono text-xs text-loom-fg-2 outline-none',
                  'data-[highlighted]:bg-white/[0.05] data-[highlighted]:text-loom-fg data-[selected]:text-loom-fg',
                  'data-[disabled]:cursor-not-allowed data-[disabled]:text-loom-red-soft data-[disabled]:data-[highlighted]:bg-loom-red-tint',
                )}
              >
                <BaseSelect.ItemText>{o.label}</BaseSelect.ItemText>
                <BaseSelect.ItemIndicator className="text-loom-accent">
                  <Check size={13} />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
