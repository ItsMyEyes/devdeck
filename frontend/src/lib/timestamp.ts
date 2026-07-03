import { format } from 'date-fns'

export interface TimestampResult {
  date: Date
  epochSeconds: number
  epochMillis: number
  iso: string
  utc: string
  local: string
}

/**
 * Parses a unix timestamp (seconds or milliseconds) or a date/time string into a normalized
 * result. 13+ digit numbers are treated as milliseconds, shorter ones as seconds. Returns null
 * if the input can't be parsed as either.
 */
export function parseTimestampInput(input: string): TimestampResult | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  let date: Date
  if (/^-?\d+$/.test(trimmed)) {
    const num = Number(trimmed)
    const isMillis = Math.abs(num) >= 1e12
    date = new Date(isMillis ? num : num * 1000)
  } else {
    date = new Date(trimmed)
  }
  if (Number.isNaN(date.getTime())) return null

  return {
    date,
    epochSeconds: Math.floor(date.getTime() / 1000),
    epochMillis: date.getTime(),
    iso: date.toISOString(),
    utc: date.toUTCString(),
    local: format(date, 'yyyy-MM-dd HH:mm:ss (EEEE)'),
  }
}
