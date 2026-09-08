import { type ChangeEvent, useRef, useState } from 'react'
import { Copy, Download, FileInput, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { MarkdownEditor } from '@/features/issues/MarkdownEditor'
import { ApiError, convertToMarkdown, type MarkitdownResult } from '@/lib/api'
import { saveText } from '@/lib/saveFile'

/** Uploads a document (pdf/docx/pptx/xlsx/image/html/...) and converts it to markdown - fully self-contained, no external tools required. */
export function MarkitdownCard() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<MarkitdownResult | null>(null)

  async function handleFilePick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setPending(true)
    try {
      const res = await convertToMarkdown(file)
      setResult(res)
      toast.success(`Converted ${res.filename} to markdown`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Conversion failed')
    } finally {
      setPending(false)
    }
  }

  function copyMarkdown() {
    if (!result) return
    void navigator.clipboard.writeText(result.markdown)
    toast.success('Markdown copied to clipboard')
  }

  function downloadMarkdown() {
    if (!result) return
    const name = result.filename.replace(/\.[^./]+$/, '') + '.md'
    void saveText(result.markdown, name, 'text/markdown;charset=utf-8').catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : `Could not save ${name}`)
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-control border border-devdeck-border-card bg-devdeck-glass-solid">
      <div className="flex items-center justify-between gap-3 border-b border-devdeck-border-card px-3.5 py-2.5">
        <div>
          <div className="text-[12.5px] font-medium text-devdeck-fg">Convert to Markdown</div>
          <div className="mt-0.5 text-[11px] text-devdeck-fg-2">
            PDF, Word, PowerPoint, Excel, images, HTML → markdown. Nothing to install.
          </div>
        </div>
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => fileInputRef.current?.click()}>
          {pending ? <Loader2 size={13} className="animate-spin" /> : <FileInput size={13} />}
          Choose file
        </Button>
        <input ref={fileInputRef} type="file" className="hidden" onChange={handleFilePick} />
      </div>

      <div className="min-h-0 flex-1 p-3.5">
        {result ? (
          <div className="flex h-full min-h-[220px] flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[11px] text-devdeck-fg-2">{result.filename}</span>
              <div className="flex flex-none items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={copyMarkdown}>
                  <Copy size={12} />
                  Copy
                </Button>
                <Button variant="ghost" size="sm" onClick={downloadMarkdown}>
                  <Download size={12} />
                  Download .md
                </Button>
              </div>
            </div>
            <div className="min-h-[220px] flex-1 overflow-auto rounded-md border border-devdeck-border-card px-3 py-2">
              <MarkdownEditor
                value={result.markdown}
                onChange={(markdown) => setResult({ ...result, markdown })}
                placeholder="Converted markdown appears here - click to edit before copying."
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-devdeck-border-card text-center">
            <span className="text-[12px] text-devdeck-fg-2">No document converted yet</span>
            <span className="text-[11px] text-devdeck-fg-2">Choose a file to see its markdown here</span>
          </div>
        )}
      </div>
    </div>
  )
}
