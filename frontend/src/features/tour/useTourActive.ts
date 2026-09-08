import { useEffect, useState } from 'react'
import { isTourActive, subscribeTourActive } from './startTour'

/** Whether a tour is on screen right now. Module state rather than React state
 *  because `startTour` is callable from outside a component (the automatic
 *  first run), so the truth cannot live in a component's `useState`. */
export function useTourActive(): boolean {
  const [running, setRunning] = useState(isTourActive)
  useEffect(() => subscribeTourActive(setRunning), [])
  return running
}
