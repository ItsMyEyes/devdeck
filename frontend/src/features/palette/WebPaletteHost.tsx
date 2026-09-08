import { useEffect } from 'react'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { SSHQuickAddDialog } from '@/features/ssh/SSHQuickAddDialog'
import { useOpenSSHShell } from '@/features/ssh/useOpenSSHShell'
import { matchesBinding } from '@/features/keybindings/store'
import { useDevDeckStore } from '@/store/useDevDeckStore'

/** The web build's leaf id for the palette. The desktop build passes the
 *  focused tile leaf, which the palette carries back into `openSSHQuickAdd`
 *  so a host created from `ssh user@host` opens in the leaf the operator
 *  invoked it from. The web has no tile tree, so nothing consumes it — but
 *  it must stay stable, because `CommandPalette` keys its open state on the
 *  `wsId`/`leafId` pair it was opened with. */
export const WEB_LEAF_ID = 'web'

/** Mounts the command palette on the web build.
 *
 *  `CommandPalette` and `SSHQuickAddDialog` are otherwise rendered only inside
 *  `WorkspaceTileArea`, which `routes/w.$wsId.tsx` mounts on `isTauri` alone —
 *  so the palette, its Ctrl/Cmd+K chord, and every action reachable only
 *  through it simply did not exist in a browser. That is also where the
 *  desktop build registers the chord, for the same reason.
 *
 *  Deliberately not merged into `GlobalOverlays`: that renders above the
 *  workspace route too, but has no `wsId` in scope, and the palette is
 *  workspace-scoped. */
export function WebPaletteHost({ wsId }: { wsId: string }) {
  const openPalette = useDevDeckStore((s) => s.openPalette)
  const paletteOpen = useDevDeckStore((s) => s.palette.open)
  const openSSHShell = useOpenSSHShell(wsId)

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (!matchesBinding(event, 'workspace.commandPalette')) return
      event.preventDefault()
      // The palette owns Escape and its own dismissal; re-opening an already
      // open palette would only reset the query out from under the operator.
      if (paletteOpen) return
      openPalette(wsId, WEB_LEAF_ID)
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [wsId, openPalette, paletteOpen])

  return (
    <>
      <CommandPalette wsId={wsId} leafId={WEB_LEAF_ID} />
      {/* Opening the new host's shell goes through the same hook every other
          "open SSH host" path uses, so it lands on the web shell route rather
          than writing a tile tab nothing renders. */}
      <SSHQuickAddDialog onCreateSSH={openSSHShell} />
    </>
  )
}
