import { AlertCircle, Loader2, MessageCircleQuestion, SearchX, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useReflectMemory, useSearchMemory } from './useMemory'

/**
 * Manual recall/reflect — an operator asking the bank a question directly,
 * distinct from the automatic per-turn recall every agent already gets (see
 * orchestration.MemoryHooks on the Go side). Recall is fast, multi-strategy
 * search; Reflect is slower and LLM-priced (it runs Hindsight's own
 * reasoning loop over the bank) — kept as an explicit second action rather
 * than the default, matching MemoryService.Reflect's doc comment.
 */
export function MemoryAsk() {
  const [query, setQuery] = useState('')
  const search = useSearchMemory()
  const reflect = useReflectMemory()
  const untouched = !search.data && !search.isPending && !search.isError && !reflect.data && !reflect.isPending && !reflect.isError

  function runSearch() {
    if (!query.trim()) return
    search.mutate({ query })
  }
  function runReflect() {
    if (!query.trim()) return
    reflect.mutate(query)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <div className="flex flex-none items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runSearch()}
          placeholder="Ask the bank anything it might already know…"
          className="max-w-[480px]"
        />
        <Button size="sm" onClick={runSearch} disabled={search.isPending || !query.trim()} className="gap-1.5">
          {search.isPending && <Loader2 size={12} className="animate-spin" />}
          {search.isPending ? 'Recalling…' : 'Recall'}
        </Button>
        <Button size="sm" variant="secondary" onClick={runReflect} disabled={reflect.isPending || !query.trim()} className="gap-1.5">
          {reflect.isPending ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {reflect.isPending ? 'Reflecting…' : 'Reflect'}
        </Button>
      </div>

      {untouched && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <MessageCircleQuestion size={26} strokeWidth={1.5} className="text-devdeck-fg-2" />
          <p className="max-w-[360px] font-mono text-[12px] text-devdeck-fg-2">
            Recall for a quick multi-strategy search, or Reflect to have Hindsight reason over the bank for a
            synthesized answer.
          </p>
        </div>
      )}

      {reflect.isError && (
        <div className="flex items-start gap-2 rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint/20 px-3 py-2.5">
          <AlertCircle size={13} className="mt-0.5 flex-none text-devdeck-err" />
          <p className="font-mono text-[11.5px] text-devdeck-err">{(reflect.error as Error).message}</p>
        </div>
      )}
      {reflect.data && (
        <div className="flex-none rounded-lg border border-devdeck-border-accent bg-devdeck-accent-tint/30 p-3.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
            <Sparkles size={11} />
            Reflected answer
          </div>
          <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-devdeck-fg">{reflect.data.text}</p>
        </div>
      )}

      {search.isError && (
        <div className="flex items-start gap-2 rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint/20 px-3 py-2.5">
          <AlertCircle size={13} className="mt-0.5 flex-none text-devdeck-err" />
          <p className="font-mono text-[11.5px] text-devdeck-err">{(search.error as Error).message}</p>
        </div>
      )}
      {search.data && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {search.data.results.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
              <SearchX size={22} strokeWidth={1.5} className="text-devdeck-fg-2" />
              <p className="font-mono text-[12px] text-devdeck-fg-2">No matching memories.</p>
            </div>
          ) : (
            search.data.results.map((r) => (
              <div
                key={r.id}
                className="rounded-lg border border-devdeck-border-card bg-devdeck-card-wash/50 p-3 transition-colors hover:border-devdeck-border-accent/40"
              >
                <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-devdeck-fg">{r.text}</p>
                <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-devdeck-fg-2">
                  {r.type && <span>{r.type}</span>}
                  {r.scores && <span>score {r.scores.final.toFixed(2)}</span>}
                  {r.mentioned_at && <span>{new Date(r.mentioned_at).toLocaleDateString()}</span>}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
