import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { fmtRupiah } from '@/lib/format'
import type { Invoice } from '@/store/types'

const config: ChartConfig = { total: { label: 'Total', color: '#c7a3ff' } }

/** Sum of invoice amounts grouped by company, top 8 by value (rest bucketed as "Other"). */
export function RevenueByCompanyChart({ invoices }: { invoices: Invoice[] }) {
  const totals = new Map<string, number>()
  for (const iv of invoices) {
    const key = iv.companyName || 'Untitled client'
    totals.set(key, (totals.get(key) ?? 0) + iv.amount)
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1])
  const top = sorted.slice(0, 8)
  const rest = sorted.slice(8)
  const data = top.map(([company, total]) => ({ company, total }))
  if (rest.length > 0) {
    data.push({ company: 'Other', total: rest.reduce((sum, [, v]) => sum + v, 0) })
  }

  return (
    <div className="flex h-[260px] flex-col gap-2 rounded-lg border border-devdeck-border-card bg-devdeck-surface-2 p-4">
      <span className="font-mono text-[11px] text-devdeck-dim uppercase">Revenue per company</span>
      <ChartContainer config={config} className="flex-1">
        <BarChart data={data} layout="vertical" margin={{ left: 8 }}>
          <CartesianGrid horizontal={false} stroke="var(--devdeck-border-card)" />
          <XAxis type="number" tickLine={false} axisLine={false} fontSize={10} stroke="var(--devdeck-dim)" tickFormatter={(v) => fmtRupiah(v)} />
          <YAxis type="category" dataKey="company" tickLine={false} axisLine={false} fontSize={10} stroke="var(--devdeck-dim)" width={100} />
          <ChartTooltip content={<ChartTooltipContent formatter={(v) => fmtRupiah(Number(v))} />} />
          <Bar dataKey="total" fill="var(--color-total)" radius={4} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}
