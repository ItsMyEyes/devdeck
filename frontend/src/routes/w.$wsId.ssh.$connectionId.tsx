import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowLeft, Cable } from 'lucide-react'
import { useSSHConnections } from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { SSHShellPane } from '@/features/ssh/SSHShellPane'

export const Route = createFileRoute('/w/$wsId/ssh/$connectionId')({
  component: SSHShellRoute,
})

/** Full-screen SSH shell for the web build, where there is no tile strip to
 *  host it (see `useOpenSSHShell`). The desktop shell reaches the same pane
 *  through `WorkspaceTileArea`, so this route is what makes "Connect" work in
 *  a browser — and what makes a host linkable. */
function SSHShellRoute() {
  const { wsId, connectionId } = Route.useParams()
  const connections = useSSHConnections()
  const connection = connections.data?.find((item) => item.id === connectionId)

  if (connections.isPending) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-container bg-devdeck-pane">
        <DataLoading compact label="opening shell…" />
      </div>
    )
  }

  if (!connection) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-container bg-devdeck-pane px-4">
        <div className="flex w-full max-w-[420px] flex-col items-center rounded-control border border-devdeck-border-card bg-devdeck-glass-solid px-5 py-6 text-center">
          <Cable size={24} className="mb-3 text-devdeck-fg-2" />
          <div className="text-[13px] font-medium text-devdeck-fg-2">That SSH host is gone</div>
          <p className="mt-1 text-[12px] leading-relaxed text-devdeck-fg-2">
            It was deleted, or this link points at a host in another workspace.
          </p>
          <Link
            to="/w/$wsId/ssh"
            params={{ wsId }}
            className="mt-4 rounded-md border border-devdeck-border-accent bg-devdeck-accent-tint px-3 py-1.5 text-[12px] font-semibold text-devdeck-accent hover:bg-devdeck-accent-tint-hover"
          >
            Back to hosts
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-container bg-devdeck-pane">
      <div className="flex min-h-11 flex-none items-center gap-2 border-b border-devdeck-border px-2 py-1.5 sm:px-3">
        <Link
          to="/w/$wsId/ssh"
          params={{ wsId }}
          aria-label="Back to SSH hosts"
          className="flex h-8 w-8 flex-none items-center justify-center rounded-control text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ArrowLeft size={16} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-devdeck-fg">{connection.name}</div>
          <div className="truncate font-mono text-[10.5px] text-devdeck-fg-2">
            {connection.username}@{connection.host}:{connection.port}
          </div>
        </div>
      </div>

      <SSHShellPane connectionId={connection.id} isFocused />
    </div>
  )
}
