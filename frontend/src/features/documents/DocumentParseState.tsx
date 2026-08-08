import { FileWarning } from 'lucide-react'
import { DataLoading } from '@/features/screens/DataLoading'
import type { AsyncParseState } from './useAsyncParse'

/**
 * The loading / parse-error / empty states every document view shares. Split
 * out so each renderer only contains its own layout — and so all four surface
 * a parse failure identically.
 */
export function DocumentParseState({
  state,
  label = 'Reading document…',
  emptyLabel,
}: {
  state: Pick<AsyncParseState<unknown>, 'status' | 'error'>
  label?: string
  emptyLabel?: string
}) {
  if (state.status === 'loading') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-devdeck-pane">
        <DataLoading compact label={label} />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-devdeck-pane px-6 text-center">
        <FileWarning size={22} className="text-devdeck-yellow" />
        <span className="max-w-lg font-mono text-[11px] leading-relaxed text-devdeck-fg-2">
          {state.error ?? 'Could not read this document'}
        </span>
        <span className="max-w-lg font-mono text-[10.5px] leading-relaxed text-devdeck-fg-2">
          Download it to open in its native application.
        </span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-devdeck-pane px-6 text-center">
      <span className="font-mono text-[11px] text-devdeck-fg-2">
        {emptyLabel ?? 'Nothing to show'}
      </span>
    </div>
  )
}
