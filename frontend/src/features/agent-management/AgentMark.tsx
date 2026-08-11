import { SiClaude, SiOpenai } from '@icons-pack/react-simple-icons'
import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'

export function AgentMark({
  id,
  name,
  active = false,
  size = 'md',
  bare = false,
}: {
  id: string
  name: string
  active?: boolean
  size?: 'sm' | 'md'
  /** Drops the chip — border, fill and fixed box — leaving just the glyph at
   *  its natural colour. For places that are already a list row or a rail
   *  slot, where a second nested box only adds noise. */
  bare?: boolean
}) {
  const iconSize = size === 'sm' ? 13 : 18

  const chip = cn(
    'rounded-lg border',
    size === 'sm' ? 'h-6 w-6 text-[9px]' : 'h-9 w-9 text-[11px]',
    id === 'claude' && active
      ? 'border-[#d97757]/35 bg-[#d97757]/10 text-[#e89576]'
      : id === 'codex' && active
        ? 'border-devdeck-border-strong bg-devdeck-card-wash text-devdeck-fg'
        : active
          ? 'border-devdeck-line bg-devdeck-on text-devdeck-fg'
          : 'border-devdeck-border-card bg-devdeck-card-wash text-devdeck-fg-2',
  )

  const glyph = cn(
    size === 'sm' ? 'text-[9px]' : 'text-[11px]',
    // The brand hue is the only thing distinguishing a bare mark, so it stays
    // even when inactive; the chip variant already had a border and fill to
    // carry that job.
    id === 'claude' ? 'text-[#d97757]' : active ? 'text-devdeck-fg' : 'text-devdeck-fg-2',
  )

  return (
    <span
      className={cn('inline-flex flex-none items-center justify-center font-mono font-semibold', bare ? glyph : chip)}
      aria-hidden="true"
    >
      {id === 'claude' ? (
        <SiClaude title="" size={iconSize} />
      ) : id === 'codex' ? (
        <SiOpenai title="" size={iconSize} />
      ) : name ? (
        name.slice(0, 1).toUpperCase()
      ) : (
        <Bot size={size === 'sm' ? 12 : 16} />
      )}
    </span>
  )
}
