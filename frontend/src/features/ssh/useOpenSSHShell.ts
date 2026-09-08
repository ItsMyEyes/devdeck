import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useIsTauri } from '@/features/tabs/useIsTauri'
import { useDevDeckStore } from '@/store/useDevDeckStore'

/** Opens an SSH host's shell and actually puts it on screen.
 *
 *  The desktop shell owns SSH shells as tiles: every tab kind that isn't a
 *  worktree or a browser resolves to the bare `/w/$wsId` URL (see
 *  `WorkspaceTileArea.navigateToTab`), and the tile canvas renders the shell
 *  there. But `routes/w.$wsId.tsx` mounts `WorkspaceTileArea` on `isTauri`
 *  alone, so on the web that same navigation falls through to `<Outlet/>` —
 *  the Agents list — and the shell the operator asked for is never rendered.
 *  Connecting to a host just bounced back to Agents.
 *
 *  The web build gets a real route for the shell instead, which also makes it
 *  linkable and gives phones a back button. Every "open this SSH host" action
 *  must go through here so the two builds can't drift apart again. */
export function useOpenSSHShell(wsId: string | undefined) {
  const navigate = useNavigate()
  const isTauri = useIsTauri()
  const openSSHShellTab = useDevDeckStore((s) => s.openSSHShellTab)

  return useCallback(
    (connectionId: string) => {
      if (!wsId) return
      if (!isTauri) {
        navigate({ to: '/w/$wsId/ssh/$connectionId', params: { wsId, connectionId } })
        return
      }
      openSSHShellTab(wsId, connectionId)
      navigate({ to: '/w/$wsId', params: { wsId } })
    },
    [wsId, isTauri, navigate, openSSHShellTab],
  )
}
