import { lazy, Suspense } from 'react'
import { FileWarning } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { fmtBytes } from '@/lib/format'
import { useFileBytesTarget } from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import type { FilesTarget } from '@/features/terminal/filesTarget'
import type { DocumentFormat } from './documentKind'

// The three Office readers pull in DOM parsing and the zip reader, and the
// PDF path allocates a blob URL — none of which a session that never opens a
// document should pay for. Each format is split into its own chunk so opening
// a spreadsheet doesn't load the Word renderer either.
const DocxView = lazy(() => import('./DocxView').then((m) => ({ default: m.DocxView })))
const SheetView = lazy(() => import('./SheetView').then((m) => ({ default: m.SheetView })))
const SlidesView = lazy(() => import('./SlidesView').then((m) => ({ default: m.SlidesView })))
const PdfView = lazy(() => import('./PdfView').then((m) => ({ default: m.PdfView })))

export function DocumentViewer({
  target,
  path,
  format,
  enabled = true,
}: {
  target: FilesTarget
  path: string
  format: DocumentFormat
  /** False until the tab has been looked at — see DocumentFileTab's latch. */
  enabled?: boolean
}) {
  const { query, progress } = useFileBytesTarget(target, path, enabled && format.renderable)

  if (!format.renderable) {
    return (
      <Unsupported
        message={`${format.label}s in the legacy binary format (.${path.split('.').pop()?.toLowerCase()}) can't be previewed here.`}
        hint="Download the file to open it, or re-save it in the modern Office format."
      />
    )
  }

  if (query.isPending) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-devdeck-terminal">
        <DataLoading
          compact
          label={
            progress && progress.total > 0
              ? `downloading ${fmtBytes(progress.loaded)} of ${fmtBytes(progress.total)}…`
              : 'downloading document…'
          }
        />
      </div>
    )
  }

  if (query.error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-devdeck-terminal px-6 text-center">
        <FileWarning size={22} className="text-devdeck-yellow" />
        <span className="max-w-lg font-mono text-[11px] leading-relaxed text-devdeck-muted">
          {query.error instanceof ApiError ? query.error.message : 'Could not download this file'}
        </span>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="rounded border border-devdeck-border-strong px-3 py-1.5 text-[11px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash"
        >
          Retry
        </button>
      </div>
    )
  }

  const bytes = query.data
  if (!bytes) return null
  if (bytes.byteLength === 0) {
    return <Unsupported message="This file is empty." hint="" />
  }

  return (
    <Suspense
      fallback={
        <div className="flex min-h-0 flex-1 items-center justify-center bg-devdeck-terminal">
          <DataLoading compact label="loading viewer…" />
        </div>
      }
    >
      {format.kind === 'pdf' ? (
        <PdfView bytes={bytes} name={path.split('/').pop() ?? path} />
      ) : format.kind === 'word' ? (
        <DocxView bytes={bytes} />
      ) : format.kind === 'excel' ? (
        <SheetView bytes={bytes} />
      ) : (
        <SlidesView bytes={bytes} />
      )}
    </Suspense>
  )
}

function Unsupported({ message, hint }: { message: string; hint: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-devdeck-terminal px-6 text-center">
      <FileWarning size={22} className="text-devdeck-yellow" />
      <span className="max-w-lg font-mono text-[11px] leading-relaxed text-devdeck-muted">
        {message}
      </span>
      {hint ? (
        <span className="max-w-lg font-mono text-[10.5px] leading-relaxed text-devdeck-dim">
          {hint}
        </span>
      ) : null}
    </div>
  )
}
