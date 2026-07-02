import { useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { MarkdownPreview } from './MarkdownPreview'

type Tab = 'write' | 'preview'

const TABS: Tab[] = ['write', 'preview']

export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  placeholder?: string
}) {
  const [tab, setTab] = useState<Tab>('write')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 self-start rounded-lg border border-loom-border-strong p-0.5">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'h-6 cursor-pointer rounded-md px-2.5 font-mono text-[11px] capitalize transition-colors',
              tab === t ? 'bg-loom-popover text-loom-fg' : 'text-loom-dim hover:text-loom-fg-2',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'write' ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          rows={10}
        />
      ) : (
        <div className="rounded-lg border border-loom-border-strong bg-loom-bg px-2.5 py-2.5">
          <MarkdownPreview source={value} />
        </div>
      )}
    </div>
  )
}
