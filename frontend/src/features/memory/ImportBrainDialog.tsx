import { AlertTriangle, LoaderCircle, Upload } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { MemoryImportMode } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { useImportMemoryBrain } from './useMemory'

const MODES: { value: MemoryImportMode; label: string; hint: string }[] = [
  { value: 'merge', label: 'Merge', hint: 'Add anything new, leave existing memories untouched' },
  { value: 'replace', label: 'Replace', hint: 'Wipe existing memories first, then import fresh' },
]

/** "Import Brain" — upload a transfer ZIP produced by Export Brain, choosing
 *  whether to merge it into the current bank or wipe the bank first. Replace
 *  is destructive (deletes every existing memory/observation before
 *  importing), so it gets an inline warning rather than a second modal —
 *  proportionate for a single-operator dashboard, not a silent one-click. */
export function ImportBrainDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [mode, setMode] = useState<MemoryImportMode>('merge')
  const importBrain = useImportMemoryBrain()
  const showToast = useDevDeckStore((s) => s.showToast)

  function reset() {
    setFile(null)
    setMode('merge')
    importBrain.reset()
  }

  async function run() {
    if (!file) return
    try {
      const summary = await importBrain.mutateAsync({ file, mode })
      const raw = summary.raw ?? {}
      const imported = raw.documents_imported ?? raw.imported
      const skipped = raw.documents_skipped ?? raw.skipped
      const parts: string[] = []
      if (summary.cleared) parts.push('existing memories cleared')
      if (typeof imported === 'number') parts.push(`${imported} document${imported === 1 ? '' : 's'} imported`)
      if (typeof skipped === 'number' && skipped > 0) parts.push(`${skipped} skipped`)
      showToast(parts.length > 0 ? `Brain imported — ${parts.join(', ')}` : 'Brain imported')
      onOpenChange(false)
      reset()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Import failed')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next) }} width={440}>
      <DialogTitle>Import Brain</DialogTitle>
      <DialogDescription className="mt-1">
        Upload a brain export (.zip) from another DevDeck machine or cloud instance.
      </DialogDescription>

      <div className="mt-4 flex flex-col gap-3">
        <label className="flex cursor-pointer flex-col gap-1.5 rounded-md border border-dashed border-devdeck-border-menu px-3 py-3 text-[12px] text-devdeck-fg-2 hover:border-devdeck-border-accent hover:text-devdeck-fg">
          <span className="flex items-center gap-1.5 font-medium text-devdeck-fg">
            <Upload size={13} />
            {file ? file.name : 'Choose a .zip file'}
          </span>
          <input
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>

        <div className="flex flex-col gap-1.5">
          {MODES.map((m) => (
            <label
              key={m.value}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-devdeck-border-menu px-2.5 py-2 text-[12px] hover:bg-devdeck-hover-wash-menu"
            >
              <input
                type="radio"
                name="import-mode"
                className="mt-0.5"
                checked={mode === m.value}
                onChange={() => setMode(m.value)}
              />
              <span className="flex flex-col">
                <span className="font-medium text-devdeck-fg">{m.label}</span>
                <span className="text-devdeck-fg-2">{m.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {mode === 'replace' && (
          <div className="flex items-start gap-2 rounded-md border border-devdeck-red-tint bg-devdeck-red-tint/40 px-2.5 py-2 text-[11.5px] text-devdeck-err">
            <AlertTriangle size={14} className="mt-0.5 flex-none" />
            <span>This deletes every existing memory and observation in this bank before importing. It cannot be undone.</span>
          </div>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)} disabled={importBrain.isPending}>
          Cancel
        </Button>
        <Button
          variant={mode === 'replace' ? 'destructive-solid' : 'default'}
          size="sm"
          onClick={() => void run()}
          disabled={!file || importBrain.isPending}
        >
          {importBrain.isPending && <LoaderCircle size={13} className="animate-spin" />}
          {mode === 'replace' ? 'Replace & Import' : 'Import'}
        </Button>
      </div>
    </Dialog>
  )
}
