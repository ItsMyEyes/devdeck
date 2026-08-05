// "Hover a collapsed folder mid-drag and it opens" — the affordance that
// makes dropping into a nested destination possible without letting go of the
// drag (spec §4). VS Code opens after roughly half a second; anything much
// shorter fires while merely dragging *across* a folder on the way somewhere
// else.

import { useCallback, useEffect, useRef } from 'react'

export const AUTO_EXPAND_DELAY_MS = 600

export interface DragAutoExpand {
  /** Call from a folder row's dragover. Re-arming for the folder already
   *  being timed is a no-op, so the repeated dragover events a stationary
   *  cursor produces don't keep restarting the clock. */
  hover: (path: string) => void
  /** Call from dragleave, drop, and dragend — anything that ends the hover. */
  cancel: () => void
}

/** `onExpand` fires once per folder, after the cursor has rested on it for
 *  `AUTO_EXPAND_DELAY_MS`. The timer is torn down on unmount, so a drag
 *  interrupted by the tree re-rendering away can't expand a folder that is no
 *  longer there. */
export function useDragAutoExpand(onExpand: (path: string) => void): DragAutoExpand {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pathRef = useRef<string | null>(null)
  const onExpandRef = useRef(onExpand)
  onExpandRef.current = onExpand

  const cancel = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    pathRef.current = null
  }, [])

  const hover = useCallback(
    (path: string) => {
      if (pathRef.current === path) return
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      pathRef.current = path
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        pathRef.current = null
        onExpandRef.current(path)
      }, AUTO_EXPAND_DELAY_MS)
    },
    [],
  )

  useEffect(() => cancel, [cancel])

  return { hover, cancel }
}
