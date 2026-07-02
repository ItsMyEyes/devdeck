import type { Invoice } from '@/store/types'
import { OutstandingTrendChart } from './OutstandingTrendChart'
import { RevenueByCompanyChart } from './RevenueByCompanyChart'
import { RevenueByMonthChart } from './RevenueByMonthChart'
import { StatusBreakdownChart } from './StatusBreakdownChart'

/** Finance Analysis tab: revenue, status, and outstanding charts computed from a workspace's invoices. */
export function FinanceAnalysisTab({ invoices }: { invoices: Invoice[] }) {
  if (invoices.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center font-mono text-[12px] text-loom-dim">
        No invoices yet — charts will appear once you create one.
      </div>
    )
  }
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RevenueByMonthChart invoices={invoices} />
        <StatusBreakdownChart invoices={invoices} />
        <RevenueByCompanyChart invoices={invoices} />
        <OutstandingTrendChart invoices={invoices} />
      </div>
    </div>
  )
}
