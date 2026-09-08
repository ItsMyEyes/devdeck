import { useRef } from 'react'
import { FileWarning } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { useFileTarget } from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { FindBar } from '@/features/find/FindBar'
import { useDomFind } from '@/features/find/useDomFind'
import { useSelectAllScope } from '@/features/find/selectAllScope'
import { MarkdownPreview } from '@/features/issues/MarkdownPreview'
import type { FilesTarget } from './filesTarget'

/**
 * Read-only tab body for a `MarkdownPreviewContent` — the rendered preview
 * popped out into its own tab (MarkdownFileEditor's "open preview in new
 * tab" action), so it can sit alongside the editing `FileContent` tab for
 * the same path instead of only living in-line. Reuses the same
 * `useFileTarget` query the editor buffers do (`staleTime: 0`), so saving in
 * the editor tab refetches and updates this one too.
 *
 * `active` drives the same on-screen polling a file tab gets — a preview of a
 * document an agent is currently writing is precisely a surface that should
 * follow it. Read-only, so there is no draft to protect and no reconciliation
 * to do: whatever the query holds is what renders.
 *
 * Read-only is also why this pane has to bind Cmd+F and Cmd+A itself. There is
 * no Monaco here to supply either, and the desktop shell has no browser chrome
 * to fall back on: without these, Cmd+F did nothing at all and Cmd+A handed
 * the browser the entire app to select.
 */
export function MarkdownPreviewPane({ target, path, active = true }: { target: FilesTarget; path: string; active?: boolean }) {
  const file = useFileTarget(target, path, { live: active })
  const scrollRef = useRef<HTMLDivElement>(null)
  /** The pane, including the find bar that floats over it — so re-pressing the
   *  chord while the find input has focus still reaches this handler. */
  const paneRef = useRef<HTMLDivElement>(null)

  // `revision` is the fetched content: an agent writing this file underneath
  // the reader re-renders it, and ranges into the old text nodes would then be
  // painting over nodes that no longer exist.
  const find = useDomFind(scrollRef, { enabled: active, scopeRef: paneRef, revision: file.data?.content })
  useSelectAllScope(scrollRef, { enabled: active })

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
  //
  // `tabIndex` on the scroller for the same reason as in MarkdownFileEditor:
  // nothing in a rendered document is focusable, so without it a click never
  // moves focus off <body> and neither chord's `contains` scope can match.
  return (
    <div ref={paneRef} className="relative min-h-0 min-w-0 flex-1">
      {find.open ? <FindBar controller={find} className="absolute right-3 top-3" /> : null}
      <div ref={scrollRef} tabIndex={-1} className="h-full overflow-auto bg-notion-bg outline-none">
        <div className="w-full px-5 py-12 sm:px-14 md:px-16 xl:px-24">
          <MarkdownPreview source={file.data?.content ?? ''} />
        </div>
      </div>
    </div>
  )
}
