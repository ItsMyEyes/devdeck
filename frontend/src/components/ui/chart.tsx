import type { ComponentProps, CSSProperties, ReactNode } from 'react'
import * as RechartsPrimitive from 'recharts'
import { cn } from '@/lib/utils'

export type ChartConfig = Record<string, { label: string; color?: string }>

interface ChartContainerProps extends Omit<ComponentProps<'div'>, 'children'> {
  config: ChartConfig
  children: ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children']
}

/** Wraps a Recharts chart in a ResponsiveContainer and exposes `--color-<key>` CSS vars from config. */
export function ChartContainer({ config, className, children, ...props }: ChartContainerProps) {
  const style = Object.fromEntries(
    Object.entries(config)
      .filter(([, v]) => v.color)
      .map(([key, v]) => [`--color-${key}`, v.color]),
  ) as CSSProperties

  return (
    <div className={cn('h-full w-full', className)} style={style} {...props}>
      <RechartsPrimitive.ResponsiveContainer width="100%" height="100%">
        {children}
      </RechartsPrimitive.ResponsiveContainer>
    </div>
  )
}

interface ChartTooltipContentProps {
  active?: boolean
  payload?: Array<{ name?: ReactNode; value?: number | string; color?: string }>
  label?: string
  formatter?: (value: number | string) => string
}

/** Dark-themed tooltip body matching Loom's card styling. */
export function ChartTooltipContent({ active, payload, label, formatter }: ChartTooltipContentProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-loom-border-card bg-loom-surface-2 px-3 py-2 text-[11.5px] shadow-lg">
      {label ? <div className="mb-1 font-mono text-[10px] text-loom-dim">{label}</div> : null}
      <div className="flex flex-col gap-1">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-sm" style={{ background: p.color }} />
            <span className="text-loom-muted">{p.name}</span>
            <span className="ml-auto font-mono font-semibold text-loom-fg">
              {formatter && p.value !== undefined ? formatter(p.value) : p.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export const ChartTooltip = RechartsPrimitive.Tooltip
