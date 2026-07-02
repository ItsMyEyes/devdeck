import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { fmtRupiah } from '@/lib/format'
import type { Invoice } from '@/store/types'

const config: ChartConfig = { revenue: { label: 'Revenue', color: '#6d8bff' } }

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

/** Sum of invoice amounts grouped by createdAt's YYYY-MM, trailing 12 months. */
export function RevenueByMonthChart({ invoices }: { invoices: Invoice[] }) {
  const now = new Date()
  const months: string[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  const totals = new Map(months.map((m) => [m, 0]))
  for (const iv of invoices) {
    const ym = iv.createdAt.slice(0, 7)
    if (totals.has(ym)) totals.set(ym, (totals.get(ym) ?? 0) + iv.amount)
  }
  const data = months.map((ym) => ({ month: monthLabel(ym), revenue: totals.get(ym) ?? 0 }))

  return (
    <div className="flex h-[260px] flex-col gap-2 rounded-lg border border-loom-border-card bg-loom-surface-2 p-4">
      <span className="font-mono text-[11px] text-loom-dim uppercase">Revenue per month</span>
      <ChartContainer config={config} className="flex-1">
        <BarChart data={data}>
          <CartesianGrid vertical={false} stroke="var(--loom-border-card)" />
          <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={10} stroke="var(--loom-dim)" />
          <YAxis tickLine={false} axisLine={false} fontSize={10} stroke="var(--loom-dim)" tickFormatter={(v) => fmtRupiah(v)} width={80} />
          <ChartTooltip content={<ChartTooltipContent formatter={(v) => fmtRupiah(Number(v))} />} />
          <Bar dataKey="revenue" fill="var(--color-revenue)" radius={4} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}
