import { useState } from 'react'
import { Copy, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CopyableRow } from './CopyableRow'
import { ToolCard } from './ToolCard'

function generate(count: number): string[] {
  return Array.from({ length: count }, () => crypto.randomUUID())
}

/** Generates one or more RFC 4122 v4 UUIDs via crypto.randomUUID(). */
export function UuidTool() {
  const [count, setCount] = useState(5)
  const [uuids, setUuids] = useState<string[]>(() => generate(5))

  function regenerate() {
    setUuids(generate(Math.min(Math.max(count, 1), 100)))
  }

  function copyAll() {
    void navigator.clipboard.writeText(uuids.join('\n'))
    toast.success(`Copied ${uuids.length} UUIDs`)
  }

  return (
    <ToolCard
      title="UUID Generator"
      description="RFC 4122 v4 UUIDs, generated with the browser's cryptographically secure random source."
      actions={
        <>
          <Input
            type="number"
            min={1}
            max={100}
            value={count}
            onChange={(e) => setCount(Number(e.target.value) || 1)}
            className="w-16 text-center"
            aria-label="Count"
          />
          <Button variant="secondary" size="sm" onClick={regenerate}>
            <RefreshCw size={12} />
            Generate
          </Button>
          <Button variant="ghost" size="sm" onClick={copyAll}>
            <Copy size={12} />
            Copy all
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        {uuids.map((id, i) => (
          <CopyableRow key={i} label={`#${i + 1}`} value={id} />
        ))}
      </div>
    </ToolCard>
  )
}
