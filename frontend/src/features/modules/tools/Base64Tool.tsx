import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeftRight, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { decodeBase64Text, encodeBase64Text } from '@/lib/encoding'
import { ModeTabs } from './ModeTabs'
import { ToolCard } from './ToolCard'

type Mode = 'encode' | 'decode'

function run(mode: Mode, input: string, urlSafe: boolean): { output: string; error: string | null } {
  if (!input.trim()) return { output: '', error: null }
  try {
    const output = mode === 'encode' ? encodeBase64Text(input, urlSafe) : decodeBase64Text(input, urlSafe)
    return { output, error: null }
  } catch (err) {
    return { output: '', error: err instanceof Error ? err.message : 'Invalid input' }
  }
}

/** Base64 (and base64url) text encoder/decoder — UTF-8 aware, runs entirely client-side. */
export function Base64Tool() {
  const [mode, setMode] = useState<Mode>('encode')
  const [urlSafe, setUrlSafe] = useState(false)
  const [input, setInput] = useState('')

  const { output, error } = useMemo(() => run(mode, input, urlSafe), [mode, input, urlSafe])

  function swap() {
    setMode((m) => (m === 'encode' ? 'decode' : 'encode'))
    setInput(output || input)
  }

  function copyOutput() {
    if (!output) return
    void navigator.clipboard.writeText(output)
    toast.success('Copied to clipboard')
  }

  return (
    <ToolCard
      title="Base64 Encode / Decode"
      description="UTF-8 text ↔ Base64, with an optional URL-safe alphabet."
      actions={
        <>
          <ModeTabs
            value={mode}
            onChange={setMode}
            options={[
              { value: 'encode', label: 'Encode' },
              { value: 'decode', label: 'Decode' },
            ]}
          />
          <label className="flex items-center gap-1.5 font-mono text-[11px] text-devdeck-fg-2 select-none">
            <input type="checkbox" checked={urlSafe} onChange={(e) => setUrlSafe(e.target.checked)} className="accent-devdeck-accent" />
            URL-safe
          </label>
        </>
      }
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_auto_1fr]">
        <div className="flex min-h-[200px] flex-col gap-1.5">
          <span className="font-mono text-[10.5px] tracking-wide text-devdeck-fg-2 uppercase">
            {mode === 'encode' ? 'Text' : 'Base64'}
          </span>
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={mode === 'encode' ? 'Paste plain text…' : 'Paste base64…'}
            className="min-h-[200px] flex-1 font-mono text-[11.5px]"
            spellCheck={false}
          />
        </div>

        <div className="flex items-center justify-center lg:pt-6">
          <button
            type="button"
            onClick={swap}
            aria-label="Swap direction"
            title="Swap direction"
            className="cursor-pointer rounded-md border border-devdeck-border-menu p-1.5 text-devdeck-fg-2 hover:text-devdeck-fg"
          >
            <ArrowLeftRight size={13} />
          </button>
        </div>

        <div className="flex min-h-[200px] flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10.5px] tracking-wide text-devdeck-fg-2 uppercase">
              {mode === 'encode' ? 'Base64' : 'Text'}
            </span>
            <Button variant="ghost" size="sm" onClick={copyOutput} disabled={!output}>
              <Copy size={12} />
              Copy
            </Button>
          </div>
          {error ? (
            <div className="flex min-h-[200px] flex-1 items-start gap-2 rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint/40 p-3">
              <AlertTriangle size={14} className="mt-0.5 flex-none text-devdeck-err" />
              <div className="font-mono text-[11px] text-devdeck-fg-2">{error}</div>
            </div>
          ) : (
            <pre className="min-h-[200px] flex-1 overflow-auto rounded-lg border border-devdeck-border-card bg-devdeck-pane p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
              {output}
            </pre>
          )}
        </div>
      </div>
    </ToolCard>
  )
}
