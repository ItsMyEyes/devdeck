// Formatting helpers — ported verbatim from the Loom v2 mockup so numbers read
// identically to the design.

import { format, isValid, parseISO } from 'date-fns'

/** Compact token count: 1_840_000 → "1.84M", 96_100 → "96k". */
export function fmtTok(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'k'
  return '' + n
}

/** Rough dollar cost from token count (design heuristic: $6 / 1M tokens). */
export function fmtCost(n: number): string {
  return '$' + ((n / 1e6) * 6).toFixed(2)
}

/** Elapsed seconds → "1h 12m" past an hour, otherwise "m:ss". */
export function fmtEl(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  if (h > 0) return h + 'h ' + m + 'm'
  return m + ':' + String(ss).padStart(2, '0')
}

/** Currency with cents, e.g. 5600 → "$5,600.00". */
export function fmtMoney(n: number): string {
  return (
    '$' +
    Number(n || 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  )
}

/** Indonesian Rupiah, no decimals, e.g. 5600000 → "Rp5.600.000". */
export function fmtRupiah(n: number): string {
  return 'Rp' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })
}

/** ISO date (YYYY-MM-DD) → "Jul 20, 2026". Falls back to the raw string if unparsable. */
export function fmtDate(iso: string): string {
  if (!iso) return '—'
  const d = parseISO(iso)
  return isValid(d) ? format(d, 'MMM d, yyyy') : iso
}

/** ISO date (YYYY-MM-DD) → "January 2026". Falls back to the raw string if unparsable. */
export function fmtMonthYear(iso: string): string {
  if (!iso) return '—'
  const d = parseISO(iso)
  return isValid(d) ? format(d, 'MMMM yyyy') : iso
}

/** Byte count → "1.2 MB" / "840 KB" / "96 B". */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** True when an ISO due date (YYYY-MM-DD) is strictly before today. */
export function isPastDue(iso: string): boolean {
  const d = parseISO(iso)
  if (!isValid(d)) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return d.getTime() < today.getTime()
}
