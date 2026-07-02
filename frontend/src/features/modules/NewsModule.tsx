import { CheckCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/ui/pill'
import { TAGC, TAGC_FALLBACK } from '@/lib/constants'
import { cn } from '@/lib/utils'
import {
  useDeleteNews,
  useMarkAllNewsRead,
  useUpdateNews,
  useWorkspace,
} from '@/features/data/queries'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import { NewsEmpty } from '@/features/screens/NewsEmpty'
import { ModuleHeader } from './ModuleHeader'

/** Per-workspace news feed with read/unread tracking and delete. */
export function NewsModule({ wsId }: { wsId: string }) {
  const q = useWorkspace(wsId)
  const updateNews = useUpdateNews()
  const markAll = useMarkAllNewsRead()
  const deleteNews = useDeleteNews()

  if (q.isPending) return <DataLoading label="loading news…" />
  if (q.isError) return <DataError error={q.error} onRetry={() => q.refetch()} />

  const news = q.data?.news ?? []
  const unread = news.filter((n) => n.unread).length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ModuleHeader
        title="News"
        meta={news.length ? `${unread} unread` : undefined}
        actions={
          <Button
            variant="secondary"
            size="sm"
            disabled={!unread || markAll.isPending}
            onClick={() => markAll.mutate(wsId)}
          >
            <CheckCheck size={13} />
            Mark all read
          </Button>
        }
      />

      {news.length === 0 ? (
        <NewsEmpty />
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <div className="flex flex-col gap-1.5">
            {news.map((n) => {
              const color = TAGC[n.tag] ?? TAGC_FALLBACK
              return (
                <div
                  key={n.id}
                  onClick={() => n.unread && updateNews.mutate({ id: n.id, patch: { unread: false } })}
                  className={cn(
                    'flex items-center gap-3 rounded-[11px] border border-loom-border-card bg-loom-card px-3 py-2.5',
                    n.unread && 'cursor-pointer hover:border-loom-border-accent',
                  )}
                >
                  {n.unread ? (
                    <button
                      type="button"
                      aria-label={`Mark read: ${n.title}`}
                      onClick={() => updateNews.mutate({ id: n.id, patch: { unread: false } })}
                      className="h-2 w-2 flex-none cursor-pointer rounded-full bg-loom-accent"
                    />
                  ) : (
                    <span className="h-2 w-2 flex-none rounded-full bg-transparent" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        'truncate text-[12.5px] leading-snug',
                        n.unread ? 'font-medium text-loom-fg' : 'text-loom-muted',
                      )}
                    >
                      {n.title}
                    </div>
                    <div className="mt-[3px] font-mono text-[10.5px] text-loom-dim">
                      {n.source} · {n.time}
                    </div>
                  </div>
                  <Pill color={color}>{n.tag}</Pill>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteNews.mutate(n.id)
                    }}
                    aria-label="Delete news item"
                    className="flex-none cursor-pointer p-1 text-loom-muted-2 hover:text-loom-red-soft"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
