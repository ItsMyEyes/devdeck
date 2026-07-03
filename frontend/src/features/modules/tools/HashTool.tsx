import { useEffect, useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { digestHex, HASH_ALGORITHMS } from '@/lib/hash'
import { CopyableRow } from './CopyableRow'
import { ToolCard } from './ToolCard'

/** Computes SHA-1/256/384/512 hex digests of text as you type, via native Web Crypto. */
export function HashTool() {
  const [input, setInput] = useState('')
  const [digests, setDigests] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    if (!input) {
      setDigests({})
      return
    }
    Promise.all(HASH_ALGORITHMS.map((algo) => digestHex(input, algo))).then((results) => {
      if (cancelled) return
      setDigests(Object.fromEntries(HASH_ALGORITHMS.map((algo, i) => [algo, results[i]])))
    })
    return () => {
      cancelled = true
    }
  }, [input])

  return (
    <ToolCard title="Hash Generator" description="SHA-1, SHA-256, SHA-384, and SHA-512 hex digests of the input text.">
      <Textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Type or paste text to hash…"
        className="min-h-[100px] flex-none font-mono text-[11.5px]"
        spellCheck={false}
      />
      <div className="flex flex-col gap-1.5">
        {HASH_ALGORITHMS.map((algo) => (
          <CopyableRow key={algo} label={algo} value={digests[algo] ?? ''} />
        ))}
      </div>
    </ToolCard>
  )
}
