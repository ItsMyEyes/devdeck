import { Button } from '@/components/ui/button'
import { DevDeckLogo } from '@/features/branding/DevDeckLogo'
import { NewWorkspaceDialog } from '@/features/overlays/NewWorkspaceDialog'
import { useDevDeckStore } from '@/store/useDevDeckStore'

/** Shown when there are no workspaces at all (fresh / everything deleted). */
export function OnboardingScreen() {
  const openNewWorkspace = useDevDeckStore((s) => s.openNewWorkspace)

  return (
    <div className="flex min-h-[100dvh] w-full flex-col items-center justify-center gap-[18px] bg-devdeck-pane p-6 text-center text-devdeck-fg">
      <DevDeckLogo size={44} radius={9} />
      <div className="text-[22px] font-semibold tracking-[-0.02em]">Welcome to devdeck</div>
      <div className="max-w-[440px] text-[13.5px] leading-relaxed text-devdeck-fg-2">
        Run every company you operate from one place - coding agents, news, todos and invoices, organized per
        workspace. Create a workspace for each company you manage.
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <Button onClick={openNewWorkspace} size="xl" className="px-5">
          Create your first workspace
        </Button>
        {/* <Button
          variant="secondary"
          size="xl"
          onClick={loadDemo}
          disabled={seed.isPending}
          className="px-5 font-mono"
        >
          {seed.isPending ? 'Loading demo…' : 'Load demo data'}
        </Button> */}
      </div>
      <NewWorkspaceDialog />
    </div>
  )
}
