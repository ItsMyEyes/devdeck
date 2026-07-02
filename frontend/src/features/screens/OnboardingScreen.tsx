import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { LoomLogo } from '@/features/branding/LoomLogo'
import { NewWorkspaceDialog } from '@/features/overlays/NewWorkspaceDialog'
import { useSeed } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

/** Shown when there are no workspaces at all (fresh / everything deleted). */
export function OnboardingScreen() {
  const navigate = useNavigate()
  const openNewWorkspace = useLoomStore((s) => s.openNewWorkspace)
  const seed = useSeed()

  function loadDemo() {
    seed.mutate(undefined, {
      onSuccess: (workspaces) => {
        const first = workspaces[0]
        if (first) navigate({ to: '/w/$wsId', params: { wsId: first.id } })
      },
    })
  }

  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-[18px] bg-loom-bg p-6 text-center text-loom-fg">
      <LoomLogo size={44} gap={4} radius={5} />
      <div className="text-[22px] font-semibold tracking-[-0.02em]">Welcome to loom</div>
      <div className="max-w-[440px] text-[13.5px] leading-relaxed text-loom-muted">
        Run every company you operate from one place — coding agents, news, todos and invoices, organized per
        workspace. Create a workspace for each company you manage.
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <Button onClick={openNewWorkspace} size="xl" className="px-5">
          Create your first workspace
        </Button>
        <Button
          variant="secondary"
          size="xl"
          onClick={loadDemo}
          disabled={seed.isPending}
          className="px-5 font-mono"
        >
          {seed.isPending ? 'Loading demo…' : 'Load demo data'}
        </Button>
      </div>
      <NewWorkspaceDialog />
    </div>
  )
}
