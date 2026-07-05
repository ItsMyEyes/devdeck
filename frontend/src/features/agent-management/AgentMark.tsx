import { SiClaude, SiOpenai } from '@icons-pack/react-simple-icons'
import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'

export function AgentMark({
  id,
  name,
  active = false,
  size = 'md',
}: {
  id: string
  name: string
  active?: boolean
  size?: 'sm' | 'md'
}) {
  const iconSize = size === 'sm' ? 13 : 18

  return (
    <span
      className={cn(
        'inline-flex flex-none items-center justify-center rounded-lg border font-mono font-semibold',
        size === 'sm' ? 'h-6 w-6 text-[9px]' : 'h-9 w-9 text-[11px]',
        id === 'claude' && active
          ? 'border-[#d97757]/35 bg-[#d97757]/10 text-[#e89576]'
          : id === 'codex' && active
            ? 'border-loom-border-strong bg-loom-surface-2 text-loom-fg'
            : active
              ? 'border-loom-border-accent bg-loom-accent-tint text-loom-accent-soft'
              : 'border-loom-border-card bg-loom-surface-2 text-loom-muted-2',
      )}
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
