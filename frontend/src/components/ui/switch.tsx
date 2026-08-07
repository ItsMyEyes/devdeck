import { Switch as BaseSwitch } from '@base-ui/react/switch'
import { cn } from '@/lib/utils'

interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

/** Thin wrapper over Base UI Switch with the devdeck track/thumb styling —
 *  the same classes SocksPublishSection.tsx already applies inline to its own
 *  `Switch.Root`/`Switch.Thumb`, lifted here so every other call site shares
 *  one definition instead of re-deriving the track/thumb colors. */
export function Switch({ checked, onCheckedChange, disabled, className, ...rest }: SwitchProps) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={rest['aria-label']}
      className={cn(
        'relative inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full bg-devdeck-card-wash transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[checked]:bg-devdeck-run',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <BaseSwitch.Thumb
        className={cn(
          'pointer-events-none block h-3.5 w-3.5 translate-x-1 rounded-full bg-devdeck-fg-2 transition-transform duration-150',
          'data-[checked]:translate-x-[18px] data-[checked]:bg-devdeck-accent-ink',
        )}
      />
    </BaseSwitch.Root>
  )
}
