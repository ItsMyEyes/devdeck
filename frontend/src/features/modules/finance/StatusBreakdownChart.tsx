import { Cell, Pie, PieChart } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { INVST } from '@/lib/constants'
import { fmtRupiah } from '@/lib/format'
import type { Invoice, InvoiceStatus } from '@/store/types'

const config: ChartConfig = Object.fromEntries(
  (Object.keys(INVST) as InvoiceStatus[]).map((s) => [s, { label: INVST[s].label, color: INVST[s].color }]),
)

/** Count and total value of invoices grouped by status. */
export function StatusBreakdownChart({ invoices }: { invoices: Invoice[] }) {
  const statuses = Object.keys(INVST) as InvoiceStatus[]
  const data = statuses
    .map((s) => {
      const matching = invoices.filter((iv) => iv.status === s)
      return { status: s, name: INVST[s].label, value: matching.reduce((sum, iv) => sum + iv.amount, 0), count: matching.length }
    })
    .filter((d) => d.count > 0)

  return (
    <div className="flex h-[260px] flex-col gap-2 rounded-lg border border-loom-border-card bg-loom-surface-2 p-4">
      <span className="font-mono text-[11px] text-loom-dim uppercase">Status breakdown</span>
      {data.length === 0 ? (
        <div className="flex flex-1 items-center justify-center font-mono text-[11px] text-loom-dim">No invoices yet</div>
      ) : (
        <ChartContainer config={config} className="flex-1">
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent formatter={(v) => fmtRupiah(Number(v))} />} />
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
              {data.map((d) => (
                <Cell key={d.status} fill={INVST[d.status].color} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
      )}
    </div>
  )
}
