import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { MarkdownEditor } from '@/features/issues/MarkdownEditor'
import { ApiError, exportMarkdown, type MarkdownExportFormat } from '@/lib/api'

const FORMAT_OPTIONS = [
  { value: 'docx', label: 'Word (.docx)' },
  { value: 'pdf', label: 'PDF (.pdf)' },
]

/** Exports markdown to docx/pdf via pandoc, rendering \`\`\`mermaid fenced blocks to images first. */
export function MarkdownExportCard() {
  const [markdown, setMarkdown] = useState('')
  const [filename, setFilename] = useState('document')
  const [format, setFormat] = useState<MarkdownExportFormat>('docx')
  const [pending, setPending] = useState(false)

  async function handleExport() {
    if (!markdown.trim()) {
      toast.error('Markdown is required')
      return
    }
    setPending(true)
    try {
      const blob = await exportMarkdown(markdown, format, filename || 'document')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${filename || 'document'}.${format}`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`Exported ${format.toUpperCase()}`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Export failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-[11px] border border-loom-border-card bg-loom-card">
      <div className="flex items-center justify-between gap-3 border-b border-loom-border-card px-3.5 py-2.5">
        <div>
          <div className="text-[12.5px] font-medium text-loom-fg">Markdown → Document</div>
          <div className="mt-0.5 text-[11px] text-loom-muted">
            Renders mermaid diagrams to images, then exports via pandoc.
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3.5">
        <div className="min-h-[220px] flex-1 overflow-auto rounded-md border border-loom-border-card px-3 py-2">
          <MarkdownEditor
            value={markdown}
            onChange={setMarkdown}
            placeholder='Write markdown — click to edit, type "/" for headings, tables, mermaid…'
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="filename"
            className="w-40 flex-none"
            aria-label="Output filename"
          />
          <Select
            value={format}
            onValueChange={(v) => setFormat(v as MarkdownExportFormat)}
            options={FORMAT_OPTIONS}
            className="w-40 flex-none"
            aria-label="Export format"
          />
          <div className="flex-1" />
          <Button size="sm" disabled={pending} onClick={handleExport}>
            {pending ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            Export
          </Button>
        </div>
      </div>
    </div>
  )
}
