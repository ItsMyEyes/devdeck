import { type ChangeEvent, useRef, useState } from 'react'
import { AlertTriangle, Archive, Download, FileInput, Loader2, ShieldCheck, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { gzipCompress, gzipDecompress } from '@/lib/compress'
import { digestHexBytes } from '@/lib/hash'
import { saveBlob } from '@/lib/saveFile'
import { ModeTabs } from './ModeTabs'
import { ToolCard } from './ToolCard'

type Mode = 'compress' | 'decompress'

interface Outcome {
  filename: string
  blob: Blob
  inputBytes: number
  outputBytes: number
  sha256: string
  verified: boolean
}

function formatBytes(n: number) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/**
 * Lossless data compression (gzip: DEFLATE + CRC32) entirely in the browser -
 * nothing installed, nothing uploaded. Compress mode self-verifies by
 * decompressing its own output and comparing SHA-256 digests before the
 * download button ever unlocks; decompress mode relies on gzip's own CRC32
 * trailer, which DecompressionStream refuses to pass on mismatch.
 */
export function CompressTool() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<Mode>('compress')
  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  function reset() {
    setError(null)
    setOutcome(null)
  }

  function switchMode(next: Mode) {
    setMode(next)
    setFile(null)
    setText('')
    reset()
  }

  function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setFile(f)
    reset()
  }

  function clearFile() {
    setFile(null)
    reset()
  }

  async function run() {
    setError(null)
    setOutcome(null)

    let inputBytes: Uint8Array<ArrayBuffer>
    let baseName: string
    if (file) {
      inputBytes = new Uint8Array(await file.arrayBuffer())
      baseName = file.name
    } else if (mode === 'compress' && text) {
      inputBytes = new TextEncoder().encode(text)
      baseName = 'data.txt'
    } else {
      toast.error(mode === 'compress' ? 'Nothing to compress - paste text or choose a file' : 'Choose a .gz file to decompress')
      return
    }
    if (inputBytes.length === 0) {
      toast.error('Input is empty')
      return
    }

    setPending(true)
    try {
      if (mode === 'compress') {
        const compressed = await gzipCompress(inputBytes)
        // Round-trip before ever offering a download: decompress our own
        // output and compare digests, so "verified" means proven, not assumed.
        const restored = await gzipDecompress(compressed)
        const [originalDigest, restoredDigest] = await Promise.all([
          digestHexBytes(inputBytes, 'SHA-256'),
          digestHexBytes(restored, 'SHA-256'),
        ])
        const verified = restored.length === inputBytes.length && originalDigest === restoredDigest
        if (!verified) {
          setError('Integrity check failed: the compressed output did not round-trip back to the original bytes. Refusing to offer a download.')
          return
        }
        setOutcome({
          filename: `${baseName}.gz`,
          blob: new Blob([compressed], { type: 'application/gzip' }),
          inputBytes: inputBytes.length,
          outputBytes: compressed.length,
          sha256: originalDigest,
          verified: true,
        })
        toast.success('Compressed and verified lossless')
      } else {
        let restored: Uint8Array<ArrayBuffer>
        try {
          restored = await gzipDecompress(inputBytes)
        } catch {
          setError('Not a valid gzip stream, or its CRC32 checksum does not match - the file is corrupted or not gzip.')
          return
        }
        const sha256 = await digestHexBytes(restored, 'SHA-256')
        setOutcome({
          filename: baseName.replace(/\.gz$/i, '') || 'restored.bin',
          blob: new Blob([restored]),
          inputBytes: inputBytes.length,
          outputBytes: restored.length,
          sha256,
          verified: true,
        })
        toast.success('Decompressed - CRC32 checksum matched')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed')
    } finally {
      setPending(false)
    }
  }

  async function download() {
    if (!outcome) return
    const ok = await saveBlob(outcome.blob, outcome.filename)
    if (ok) toast.success(`Saved ${outcome.filename}`)
  }

  const ratio = outcome && outcome.inputBytes > 0 ? outcome.outputBytes / outcome.inputBytes : null

  return (
    <ToolCard
      title="Data Compression"
      description="gzip (DEFLATE + CRC32) in the browser - no install, checksum-verified, nothing leaves this machine."
      actions={
        <ModeTabs
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'compress', label: 'Compress' },
            { value: 'decompress', label: 'Decompress' },
          ]}
        />
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
          <FileInput size={13} />
          {mode === 'compress' ? 'Choose file' : 'Choose .gz file'}
        </Button>
        {file ? (
          <div className="flex items-center gap-1.5 rounded-md border border-devdeck-border-card bg-devdeck-pane px-2 py-1">
            <span className="font-mono text-[11px] text-devdeck-fg-2">
              {file.name} · {formatBytes(file.size)}
            </span>
            <button
              type="button"
              onClick={clearFile}
              aria-label="Clear chosen file"
              className="cursor-pointer text-devdeck-fg-2 hover:text-devdeck-fg"
            >
              <X size={12} />
            </button>
          </div>
        ) : null}
        <input ref={fileInputRef} type="file" className="hidden" onChange={pickFile} />
        <div className="flex-1" />
        <Button size="sm" disabled={pending} onClick={() => void run()}>
          {pending ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />}
          {mode === 'compress' ? 'Compress' : 'Decompress'}
        </Button>
      </div>

      {mode === 'compress' && !file ? (
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            reset()
          }}
          placeholder="Paste text to compress, or choose a file above…"
          className="min-h-[160px] flex-1 font-mono text-[11.5px]"
          spellCheck={false}
        />
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint/40 p-3">
          <AlertTriangle size={14} className="mt-0.5 flex-none text-devdeck-err" />
          <div className="font-mono text-[11px] text-devdeck-fg-2">{error}</div>
        </div>
      ) : null}

      {outcome ? (
        <div className="flex flex-col gap-2 rounded-lg border border-devdeck-border-card bg-devdeck-pane p-3">
          <div className="flex items-center gap-1.5 text-[11.5px] text-devdeck-fg">
            <ShieldCheck size={13} className="text-devdeck-accent" />
            {mode === 'compress'
              ? 'Verified lossless: decompressed output SHA-256-matches the original'
              : 'CRC32 checksum matched - decompressed output is intact'}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-devdeck-fg-2 sm:grid-cols-4">
            <span>In: {formatBytes(outcome.inputBytes)}</span>
            <span>Out: {formatBytes(outcome.outputBytes)}</span>
            {mode === 'compress' && ratio !== null ? <span>Ratio: {(ratio * 100).toFixed(1)}%</span> : <span />}
            <span className="truncate" title={outcome.sha256}>
              SHA-256: {outcome.sha256.slice(0, 12)}…
            </span>
          </div>
          <Button variant="secondary" size="sm" className="self-start" onClick={() => void download()}>
            <Download size={13} />
            Download {outcome.filename}
          </Button>
        </div>
      ) : null}
    </ToolCard>
  )
}
