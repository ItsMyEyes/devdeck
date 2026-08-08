import { useMemo, useState } from 'react'
import { Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { parseTimestampInput } from '@/lib/timestamp'
import { CopyableRow } from './CopyableRow'
import { ToolCard } from './ToolCard'

/** Converts between unix timestamps (seconds or ms) and human-readable date/time strings. */
export function TimestampTool() {
  const [input, setInput] = useState(() => String(Math.floor(Date.now() / 1000)))

  const result = useMemo(() => parseTimestampInput(input), [input])
  const invalid = input.trim() !== '' && !result

  return (
    <ToolCard
      title="Timestamp Converter"
      description="Paste a unix timestamp (seconds or ms) or a date/time string - parses either direction."
      actions={
        <Button variant="secondary" size="sm" onClick={() => setInput(String(Math.floor(Date.now() / 1000)))}>
          <Clock size={12} />
          Now
        </Button>
      }
    >
      <Input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="1735689600 or 2025-01-01T00:00:00Z"
        className="font-mono"
        spellCheck={false}
      />
      {invalid ? (
        <div className="rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint/40 px-3 py-2 font-mono text-[11px] text-devdeck-fg-2">
          Couldn't parse that as a timestamp or date
        </div>
      ) : result ? (
        <div className="flex flex-col gap-1.5">
          <CopyableRow label="Seconds" value={String(result.epochSeconds)} />
          <CopyableRow label="Millis" value={String(result.epochMillis)} />
          <CopyableRow label="ISO" value={result.iso} />
          <CopyableRow label="UTC" value={result.utc} />
          <CopyableRow label="Local" value={result.local} />
        </div>
      ) : null}
    </ToolCard>
  )
}
