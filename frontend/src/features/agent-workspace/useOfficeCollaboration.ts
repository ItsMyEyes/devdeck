import { useEffect, useRef, useState } from 'react'
import { CollaborationTracker } from '@/features/agent-workspace/collaboration'
import type { OfficeMember } from '@/features/agent-workspace/model'
export function useOfficeCollaboration(
  members: OfficeMember[],
  visible: boolean,
) {
  const wasHidden = useRef(!visible)
  const tracker = useRef(new CollaborationTracker())
  const [state, setState] = useState({
    completed: new Set<string>(),
    delegated: new Set<string>(),
  })
  useEffect(() => {
    if (!visible) {
      wasHidden.current = true
      return
    }
    if (wasHidden.current) {
      tracker.current = new CollaborationTracker(Date.now())
      wasHidden.current = false
    }
    const update = () => {
      const next = tracker.current.update(members, performance.now())
      setState((old) =>
        [...old.completed].join() === [...next.completed].join() &&
        [...old.delegated].join() === [...next.delegated].join()
          ? old
          : next,
      )
    }
    update()
    const timer = setInterval(update, 500)
    return () => clearInterval(timer)
  }, [members, visible])
  return state
}
