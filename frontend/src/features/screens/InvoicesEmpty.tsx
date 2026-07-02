import { Receipt } from 'lucide-react'
import { EmptyState } from './EmptyState'

/** Shown when a workspace has no invoices. */
export function InvoicesEmpty() {
  return (
    <EmptyState
      icon={<Receipt size={26} strokeWidth={1.5} />}
      title="No invoices yet"
    />
  )
}
