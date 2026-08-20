import { FileWarning } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { useFileTarget } from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { MarkdownPreview } from '@/features/issues/MarkdownPreview'
import type { FilesTarget } from './filesTarget'

/**
 * Read-only tab body for a `MarkdownPreviewContent` — the rendered preview
 * popped out into its own tab (MarkdownFileEditor's "open preview in new
 * tab" action), so it can sit alongside the editing `FileContent` tab for
 * the same path instead of only living in-line. Reuses the same
 * `useFileTarget` query the editor buffers do (`staleTime: 0`), so saving in
 * the editor tab refetches and updates this one too.
 */
export function MarkdownPreviewPane({ target, path }: { target: FilesTarget; path: string }) {
  const file = useFileTarget(target, path)

  if (file.isLoading) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-notion-bg">
        <DataLoading compact label="loading preview…" />
      </div>
    )
  }

  if (file.error) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-notion-bg px-6 text-center">
        <FileWarning size={22} className="text-devdeck-yellow" />
        <span className="max-w-lg font-mono text-[11px] leading-relaxed text-devdeck-fg-2">
          {file.error instanceof ApiError ? file.error.message : 'Could not open this file'}
        </span>
      </div>
    )
  }

  // Same page geometry as the editing tab (MarkdownFileEditor's rich mode) —
  // full pane width on the same responsive padding ladder — so popping the
  // preview out beside the editor doesn't reflow the document.
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-notion-bg">
      <div className="w-full px-5 py-12 sm:px-14 md:px-16 xl:px-24">
        <MarkdownPreview source={file.data?.content ?? ''} />
      </div>
    </div>
  )
}
