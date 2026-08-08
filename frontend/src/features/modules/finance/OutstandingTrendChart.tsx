import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { fmtRupiah } from '@/lib/format'
import type { Invoice } from '@/store/types'

const config: ChartConfig = { outstanding: { label: 'Outstanding', color: '#f5c451' } }

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

/** Outstanding (sent+overdue) total per month, trailing 12 months, plus current summary. */
export function OutstandingTrendChart({ invoices }: { invoices: Invoice[] }) {
  const outstandingNow = invoices.filter((iv) => iv.status === 'sent' || iv.status === 'overdue').reduce((sum, iv) => sum + iv.amount, 0)
  const overdueNow = invoices.filter((iv) => iv.status === 'overdue').reduce((sum, iv) => sum + iv.amount, 0)

  const now = new Date()
  const months: string[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  const totals = new Map(months.map((m) => [m, 0]))
  for (const iv of invoices) {
    if (iv.status !== 'sent' && iv.status !== 'overdue') continue
    const ym = iv.createdAt.slice(0, 7)
    if (totals.has(ym)) totals.set(ym, (totals.get(ym) ?? 0) + iv.amount)
  }
  const data = months.map((ym) => ({ month: monthLabel(ym), outstanding: totals.get(ym) ?? 0 }))

  return (
    <div className="flex h-[260px] flex-col gap-3 rounded-lg border border-devdeck-border-card bg-devdeck-card-wash p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-devdeck-fg-2 uppercase">Outstanding &amp; overdue</span>
        <div className="flex gap-3 font-mono text-[11px]">
          <span className="text-devdeck-fg">Outstanding: {fmtRupiah(outstandingNow)}</span>
          <span className="text-devdeck-err">Overdue: {fmtRupiah(overdueNow)}</span>
        </div>
      </div>
      <ChartContainer config={config} className="flex-1">
        <LineChart data={data}>
          <CartesianGrid vertical={false} stroke="var(--devdeck-border-card)" />
          <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={10} stroke="var(--devdeck-fg-2)" />
          <YAxis tickLine={false} axisLine={false} fontSize={10} stroke="var(--devdeck-fg-2)" tickFormatter={(v) => fmtRupiah(v)} width={80} />
          <ChartTooltip content={<ChartTooltipContent formatter={(v) => fmtRupiah(Number(v))} />} />
          <Line type="monotone" dataKey="outstanding" stroke="var(--color-outstanding)" strokeWidth={2} dot={false} />
        </LineChart>
      </ChartContainer>
    </div>
  )
}
