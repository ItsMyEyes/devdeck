import { Area, AreaChart, YAxis } from 'recharts'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'

const config: ChartConfig = { value: { label: 'Value', color: 'var(--devdeck-accent)' } }

/** A compact filled sparkline over the rolling window. No X axis: the window
 *  is always "the last few minutes", and a timestamp axis in a pane this
 *  short costs more room than it repays. */
export function MetricChart({ data }: { data: { value: number }[] }) {
  return (
    <ChartContainer config={config} className="h-[52px] w-full">
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        {/* Fixed 0-100 domain: an auto domain rescales every tick and makes a
            flat 2% line look like a dramatic spike. */}
        <YAxis domain={[0, 100]} hide />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          fill="var(--color-value)"
          fillOpacity={0.18}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
