import { useEffect, useRef, useState } from 'react'

/**
 * Keeps the last `cap` distinct samples in memory — the whole of the metrics
 * feature's "history". Deliberately not persisted: this is a live ops readout,
 * so the window resets when the pane closes.
 *
 * Identity, not value, decides what counts as new: TanStack Query hands back
 * the same object across unrelated re-renders, and appending on every render
 * would fill the buffer with duplicates in seconds.
 */
export function useRollingSamples<T>(latest: T | undefined, cap: number): T[] {
  const [samples, setSamples] = useState<T[]>([])
  const lastRef = useRef<T | undefined>(undefined)

  useEffect(() => {
    if (latest === undefined || latest === lastRef.current) return
    lastRef.current = latest
    setSamples((prev) => {
      const next = [...prev, latest]
      return next.length > cap ? next.slice(next.length - cap) : next
    })
  }, [latest, cap])

  return samples
}
