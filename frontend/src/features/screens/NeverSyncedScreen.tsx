import { CloudOff } from 'lucide-react'
import { DevDeckLogo } from '@/features/branding/DevDeckLogo'

/**
 * Shown instead of OnboardingScreen when this runtime's catalog replica has
 * never been filled. A never-synced runtime otherwise looks identical to a
 * fresh hub with zero workspaces — hiding the most common misconfiguration
 * (a wrong --hub-key/--hub-url) behind a "create your first workspace"
 * prompt the runtime can't even act on, since workspace creation is hub-only.
 */
export function NeverSyncedScreen({ machineName }: { machineName: string }) {
  return (
    <div className="flex min-h-[100dvh] w-full flex-col items-center justify-center gap-[18px] bg-devdeck-pane p-6 text-center text-devdeck-fg">
      <DevDeckLogo size={44} radius={9} />
      <CloudOff size={28} strokeWidth={1.5} className="text-devdeck-fg-2" />
      <div className="text-[22px] font-semibold tracking-[-0.02em]">
        {machineName || 'This runtime'} hasn&rsquo;t synced yet
      </div>
      <div className="max-w-[440px] text-[13.5px] leading-relaxed text-devdeck-fg-2">
        This runtime has not received a catalog from its hub. Check <code>--hub-url</code> and{' '}
        <code>--hub-key</code>, then look at this runtime&rsquo;s log - a wrong hub key otherwise looks
        exactly like an empty account.
      </div>
    </div>
  )
}
