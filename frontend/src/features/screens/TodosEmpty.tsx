import { CheckSquare } from 'lucide-react'
import { EmptyState } from './EmptyState'

/** Shown when a workspace has no todos. */
export function TodosEmpty() {
  return (
    <EmptyState
      icon={<CheckSquare size={26} strokeWidth={1.5} />}
      title="No tasks yet"
    />
  )
}
