import { Inbox } from 'lucide-react'
import { EmptyState } from './EmptyState'

/** Shown when a workspace has no news items. */
export function NewsEmpty() {
  return (
    <EmptyState
      icon={<Inbox size={26} strokeWidth={1.5} />}
      title="You are all caught up"
    />
  )
}
