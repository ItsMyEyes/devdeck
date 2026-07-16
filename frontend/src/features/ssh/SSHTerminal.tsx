import { useEffect, useRef } from 'react'
import { attachSSHSession } from './sshTerminalRegistry'

/** xterm.js wired to the hub's /ws/ssh gateway for one saved connection.
 *  Unlike the worktree Terminal there is no server-side reattach registry:
 *  the remote shell lives exactly as long as this socket, so a dropped
 *  connection is NOT silently retried (that would open a fresh shell and
 *  discard remote state without the user asking) — Enter reconnects.
 *
 *  The socket/`XTerm` instance itself lives in `sshTerminalRegistry`, keyed
 *  by `sessionKey`, not in this component — `PaneCanvas` remounts this leaf
 *  on every drag-to-split/merge move (a pure view change), and this
 *  component just reattaches the same live session into its new host div
 *  instead of reconnecting. */
export function SSHTerminal({ connectionId, sessionKey }: { connectionId: string; sessionKey: string }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const { term, refit } = attachSSHSession(sessionKey, connectionId, host)
    term.focus()

    // Trailing-edge debounce, mirroring Terminal.tsx: fold resize bursts
    // (mobile keyboard, divider drags) into a single fit + SIGWINCH.
    let fitTimer: number | undefined
    const ro = new ResizeObserver(() => {
      if (fitTimer !== undefined) window.clearTimeout(fitTimer)
      fitTimer = window.setTimeout(() => {
        fitTimer = undefined
        try {
          refit()
        } catch {
          /* host detached */
        }
      }, 150)
    })
    ro.observe(host)

    return () => {
      if (fitTimer !== undefined) window.clearTimeout(fitTimer)
      ro.disconnect()
      // Deliberately no session teardown here — this may just be the leaf
      // moving to a new pane. Real close goes through `disposeSSHSession`
      // (see SSHShellPane's close-tab/close-pane/unmount handling).
    }
  }, [connectionId, sessionKey])

  return <div ref={hostRef} className="h-full w-full" />
}
