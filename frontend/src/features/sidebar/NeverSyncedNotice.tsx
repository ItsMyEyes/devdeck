import { CloudOff } from 'lucide-react'
import { fmtTimeAgo } from '@/lib/format'

/**
 * A runtime whose replica has never been filled looks identical to one with
 * no projects. That ambiguity hides the most common misconfiguration — a
 * wrong --hub-key — so the two states are rendered distinctly and the
 * failure is named rather than shown as a normal empty list.
 */
export function NeverSyncedNotice({ lastSyncedAt }: { lastSyncedAt: string | null }) {
  if (lastSyncedAt === null) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <CloudOff size={20} strokeWidth={1.5} className="text-devdeck-dim" />
        <p className="text-[13px] font-medium text-devdeck-fg-2">Never synced with the hub</p>
        <p className="text-[11.5px] text-devdeck-dim">
          This runtime has not received a catalog yet. Check <code>--hub-url</code> and{' '}
          <code>--hub-key</code>, then look at this runtime&rsquo;s log.
        </p>
      </div>
    )
  }
  return (
    <p className="px-4 py-2 text-[11.5px] text-devdeck-dim">Catalog synced {fmtTimeAgo(lastSyncedAt)}</p>
  )
}
