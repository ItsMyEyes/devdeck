import { type ChangeEvent, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Copy, Download, ListTree, Table2, Trash2, Upload, WrapText } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  type DataFormat,
  detectFormat,
  formatCsv,
  formatJson,
  formatXml,
  highlightJsonHtml,
  highlightXmlHtml,
} from '@/lib/formatters'
import { cn } from '@/lib/utils'
import { CsvTableView } from './CsvTableView'
import { JsonTreeView } from './JsonTreeView'

const FORMAT_OPTIONS = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'json', label: 'JSON' },
  { value: 'xml', label: 'XML' },
  { value: 'csv', label: 'CSV' },
]

const SAMPLES: Record<DataFormat, string> = {
  json: '{"id":"ws-1","name":"DevDeck","active":true,"tags":["dashboard","agents"],"stats":{"projects":3,"todos":null}}',
  xml: '<workspace id="ws-1"><name>DevDeck</name><projects><project active="true">agent</project><project active="false">web</project></projects></workspace>',
  csv: 'id,name,role,active\n1,Andi Syahruddin,Engineer,true\n2,Budi Santoso,Designer,false',
}

const EXTENSION: Record<DataFormat, string> = { json: 'json', xml: 'xml', csv: 'csv' }

interface FormatOutcome {
  format: DataFormat
  pretty: string
  jsonValue?: unknown
  csvRows?: string[][]
  error: string | null
}

function runFormat(input: string, format: DataFormat): FormatOutcome {
  try {
    if (format === 'json') {
      const { pretty, value } = formatJson(input)
      return { format, pretty, jsonValue: value, error: null }
    }
    if (format === 'xml') {
      return { format, pretty: formatXml(input), error: null }
    }
    const { rows, aligned } = formatCsv(input)
    return { format, pretty: aligned, csvRows: rows, error: null }
  } catch (err) {
    return { format, pretty: '', error: err instanceof Error ? err.message : 'Invalid input' }
  }
}

/** Beautifies and visually explores pasted JSON, XML, or CSV — parses client-side, no upload required. */
export function FormatterTool() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [input, setInput] = useState('')
  const [formatChoice, setFormatChoice] = useState<'auto' | DataFormat>('auto')
  const [view, setView] = useState<'text' | 'structured'>('structured')

  const resolvedFormat: DataFormat = formatChoice === 'auto' ? detectFormat(input) : formatChoice
  const outcome = useMemo(() => (input.trim() ? runFormat(input, resolvedFormat) : null), [input, resolvedFormat])

  const meta = useMemo(() => {
    if (!input.trim()) return null
    const lines = input.split(/\r?\n/).length
    const bytes = new Blob([input]).size
    const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
    if (outcome?.csvRows) return `${size} · ${lines} lines · ${outcome.csvRows.length} rows × ${outcome.csvRows[0]?.length ?? 0} cols`
    return `${size} · ${lines} lines`
  }, [input, outcome])

  function loadSample() {
    const fmt = formatChoice === 'auto' ? 'json' : formatChoice
    setInput(SAMPLES[fmt])
  }

  function handleFilePick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    file.text().then((text) => {
      setInput(text)
      const ext = file.name.split('.').pop()?.toLowerCase()
      if (ext === 'json' || ext === 'xml' || ext === 'csv') setFormatChoice(ext)
    })
  }

  function copyOutput() {
    if (!outcome || outcome.error) return
    void navigator.clipboard.writeText(outcome.pretty)
    toast.success('Copied to clipboard')
  }

  function downloadOutput() {
    if (!outcome || outcome.error) return
    const blob = new Blob([outcome.pretty], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `formatted.${EXTENSION[outcome.format]}`
    a.click()
    URL.revokeObjectURL(url)
  }

  const hasStructuredView = outcome?.format === 'json' || outcome?.format === 'csv'
  const highlightedHtml =
    outcome && !outcome.error
      ? outcome.format === 'json'
        ? highlightJsonHtml(outcome.pretty)
        : outcome.format === 'xml'
          ? highlightXmlHtml(outcome.pretty)
          : null
      : null

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-control border border-devdeck-border-card bg-devdeck-glass-solid">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-devdeck-border-card px-3.5 py-2.5">
        <div>
          <div className="text-[12.5px] font-medium text-devdeck-fg">JSON / XML / CSV Beautifier</div>
          <div className="mt-0.5 text-[11px] text-devdeck-fg-2">
            Paste or upload data - formats, validates, and lets you explore it as a tree or table.
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Select
            value={formatChoice}
            onValueChange={(v) => setFormatChoice(v as 'auto' | DataFormat)}
            options={FORMAT_OPTIONS}
            className="w-[130px]"
            aria-label="Format"
          />
          <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload size={12} />
            Upload
          </Button>
          <input ref={fileInputRef} type="file" accept=".json,.xml,.csv,.txt" className="hidden" onChange={handleFilePick} />
          <Button variant="ghost" size="sm" onClick={loadSample}>
            Load sample
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3.5 lg:grid-cols-2">
        <div className="flex min-h-[220px] flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10.5px] tracking-wide text-devdeck-fg-2 uppercase">Input</span>
            <button
              onClick={() => setInput('')}
              disabled={!input}
              className="flex cursor-pointer items-center gap-1 font-mono text-[10.5px] text-devdeck-fg-2 hover:text-devdeck-err disabled:pointer-events-none disabled:opacity-40"
            >
              <Trash2 size={11} />
              Clear
            </button>
          </div>
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste JSON, XML, or CSV here…"
            className="min-h-[220px] flex-1 font-mono text-[11.5px]"
            spellCheck={false}
          />
        </div>

        <div className="flex min-h-[220px] flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10.5px] tracking-wide text-devdeck-fg-2 uppercase">Output</span>
              {resolvedFormat && input.trim() ? (
                <span className="rounded-md bg-devdeck-on px-1.5 py-0.5 font-mono text-[10px] text-devdeck-fg-2 uppercase">
                  {resolvedFormat}
                </span>
              ) : null}
              {meta ? <span className="font-mono text-[10.5px] text-devdeck-fg-2">{meta}</span> : null}
            </div>
            <div className="flex items-center gap-1">
              {hasStructuredView ? (
                <div className="flex rounded-md border border-devdeck-border-menu p-0.5">
                  <button
                    onClick={() => setView('text')}
                    className={cn(
                      'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10.5px] transition-colors',
                      view === 'text' ? 'bg-devdeck-on text-devdeck-fg' : 'text-devdeck-fg-2 hover:text-devdeck-fg',
                    )}
                  >
                    <WrapText size={11} />
                    Text
                  </button>
                  <button
                    onClick={() => setView('structured')}
                    className={cn(
                      'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10.5px] transition-colors',
                      view === 'structured' ? 'bg-devdeck-on text-devdeck-fg' : 'text-devdeck-fg-2 hover:text-devdeck-fg',
                    )}
                  >
                    {outcome?.format === 'csv' ? <Table2 size={11} /> : <ListTree size={11} />}
                    {outcome?.format === 'csv' ? 'Table' : 'Tree'}
                  </button>
                </div>
              ) : null}
              <Button variant="ghost" size="sm" onClick={copyOutput} disabled={!outcome || !!outcome.error}>
                <Copy size={12} />
                Copy
              </Button>
              <Button variant="ghost" size="sm" onClick={downloadOutput} disabled={!outcome || !!outcome.error}>
                <Download size={12} />
                Download
              </Button>
            </div>
          </div>

          {!outcome ? (
            <div className="flex h-full min-h-[220px] flex-1 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-devdeck-border-card text-center">
              <span className="text-[12px] text-devdeck-fg-2">Nothing to format yet</span>
              <span className="text-[11px] text-devdeck-fg-2">Paste data on the left to see it beautified here</span>
            </div>
          ) : outcome.error ? (
            <div className="flex min-h-[220px] flex-1 items-start gap-2 rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint/40 p-3">
              <AlertTriangle size={14} className="mt-0.5 flex-none text-devdeck-err" />
              <div>
                <div className="text-[12px] font-medium text-devdeck-err">Invalid {resolvedFormat.toUpperCase()}</div>
                <div className="mt-0.5 font-mono text-[11px] text-devdeck-fg-2">{outcome.error}</div>
              </div>
            </div>
          ) : view === 'structured' && outcome.format === 'json' ? (
            <JsonTreeView value={outcome.jsonValue} />
          ) : view === 'structured' && outcome.format === 'csv' && outcome.csvRows ? (
            <CsvTableView rows={outcome.csvRows} />
          ) : highlightedHtml ? (
            <pre
              className="min-h-[220px] flex-1 overflow-auto rounded-lg border border-devdeck-border-card bg-devdeck-pane p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap"
              // eslint-disable-next-line react/no-danger -- highlightedHtml is generated by highlightJsonHtml/highlightXmlHtml, which HTML-escapes the source text before wrapping matched tokens in fixed-class spans; no user string reaches the DOM unescaped.
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          ) : (
            <pre className="min-h-[220px] flex-1 overflow-auto rounded-lg border border-devdeck-border-card bg-devdeck-pane p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
              {outcome.pretty}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
