import { Area, AreaChart, YAxis } from 'recharts'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'

const config: ChartConfig = { value: { label: 'Value', color: 'var(--devdeck-accent)' } }

/** A compact filled sparkline over the rolling window. No X axis: the window
 *  is always "the last few minutes", and a timestamp axis in a pane this
 *  short costs more room than it repays.
 *
 *  `value` is nullable because "unknown" is a real reading here: the first CPU
 *  sample after a pane opens has no delta to measure, and so does the sample
 *  after a host reboots. Those points are plotted as gaps, never as zeros. */
export function MetricChart({ data }: { data: { value: number | null }[] }) {
  return (
    <ChartContainer config={config} className="h-[52px] w-full">
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        {/* Fixed 0-100 domain: an auto domain rescales every tick and makes a
            flat 2% line look like a dramatic spike. */}
        <YAxis domain={[0, 100]} hide />
        {/* Explicitly not connecting nulls: a bridged gap is a line drawn
            through data that does not exist, and here it would draw straight
            across a reboot. Stated rather than left to the library default so
            it survives a recharts upgrade. */}
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          fill="var(--color-value)"
          fillOpacity={0.18}
          strokeWidth={1.5}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
