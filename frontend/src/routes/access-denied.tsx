import { createFileRoute } from '@tanstack/react-router'
import { ShieldX } from 'lucide-react'

export const Route = createFileRoute('/access-denied')({
  component: AccessDeniedPage,
})

function AccessDeniedPage() {
  return (
    <div className="flex min-h-[100dvh] w-full items-center justify-center bg-devdeck-pane px-4 text-devdeck-fg">
      <div className="w-[380px] rounded-control border border-devdeck-border-card bg-devdeck-glass-solid px-11 py-10 text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-control bg-devdeck-red-tint text-devdeck-red">
          <ShieldX className="size-5" />
        </div>
        <h1 className="mb-2.5 text-base font-medium">Access denied</h1>
        <p className="text-[12.5px] leading-relaxed text-devdeck-fg-2">
          This DevDeck instance only accepts connections from approved IP addresses. Your address is
          not on the allowlist.
        </p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-devdeck-fg-2">
          If you believe this is a mistake, contact the operator of this instance.
        </p>
        <div className="mt-5 text-[11px] tracking-[0.08em] text-devdeck-fg-2">
          HTTP 403 · IP RESTRICTED
        </div>
      </div>
    </div>
  )
}
