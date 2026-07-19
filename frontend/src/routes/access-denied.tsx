import { createFileRoute } from '@tanstack/react-router'
import { ShieldX } from 'lucide-react'

export const Route = createFileRoute('/access-denied')({
  component: AccessDeniedPage,
})

function AccessDeniedPage() {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-devdeck-bg text-devdeck-fg">
      <div className="w-[380px] rounded-[10px] border border-devdeck-border-card bg-devdeck-elevated px-11 py-10 text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-[10px] bg-devdeck-red-tint text-devdeck-red">
          <ShieldX className="size-5" />
        </div>
        <h1 className="mb-2.5 text-base font-medium">Access denied</h1>
        <p className="text-[12.5px] leading-relaxed text-devdeck-muted">
          This DevDeck instance only accepts connections from approved IP addresses. Your address is
          not on the allowlist.
        </p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-devdeck-muted">
          If you believe this is a mistake, contact the operator of this instance.
        </p>
        <div className="mt-5 text-[11px] tracking-[0.08em] text-devdeck-muted-2">
          HTTP 403 · IP RESTRICTED
        </div>
      </div>
    </div>
  )
}
