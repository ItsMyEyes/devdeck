import { useCallback, useEffect, useState } from 'react'
import { readTourLang, setTourLang, subscribeTourLang, type TourLang } from './tourPrefs'

/**
 * The tour's language, and a setter that writes it through to every subscriber.
 *
 * Same shape as `useThemePreference` for the same reason: the value lives in
 * localStorage rather than in React, so a component that changes it and a
 * component that displays it stay in step through the module's own listener
 * set instead of through shared props.
 */
export function useTourLang(): [TourLang, (next: TourLang) => void] {
  const [lang, setLang] = useState<TourLang>(readTourLang)
  useEffect(() => subscribeTourLang(setLang), [])
  return [lang, useCallback((next: TourLang) => setTourLang(next), [])]
}
