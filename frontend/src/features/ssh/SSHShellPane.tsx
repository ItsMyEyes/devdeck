import { SSHTerminal } from './SSHTerminal'

/** Tile body for the 'ssh-shell' tab kind — same chrome as the worktree
 *  terminal renderer in ExpandedTerminal.tsx. */
export function SSHShellPane({ connectionId }: { connectionId: string }) {
  return (
    <div className="h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden bg-loom-terminal px-3 py-2">
      <SSHTerminal key={connectionId} connectionId={connectionId} />
    </div>
  )
}
