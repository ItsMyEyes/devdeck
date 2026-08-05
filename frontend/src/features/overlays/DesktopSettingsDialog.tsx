import { Switch } from '@base-ui/react/switch'
import {
  ArrowLeft,
  Code2,
  Copy,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Radio,
  ScrollText,
  Settings,
  TriangleAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { StatusDot } from '@/components/ui/status-dot'
import { changeHub, openLogFile } from '@/features/desktop/desktopBridge'
import { useMachines, useTailscaleStatus } from '@/features/data/queries'
import { useVsCodeMode } from '@/features/editor/useVsCodeMode'
import type { TailscaleHubStatus } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { SocksPublishSection } from './SocksPublishSection'
import { VersionSection } from './VersionSection'

const MASKED_KEY = '••••••••••••••••'

type SectionId = 'general' | 'access' | 'network' | 'editor' | 'diagnostics' | 'about'

interface NavItem {
  id: SectionId
  label: string
  icon: LucideIcon
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Hub',
    items: [
      { id: 'general', label: 'General', icon: Settings },
      { id: 'access', label: 'Access', icon: KeyRound },
      { id: 'network', label: 'Network', icon: Radio },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'editor', label: 'Editor', icon: Code2 },
      { id: 'diagnostics', label: 'Diagnostics', icon: ScrollText },
      { id: 'about', label: 'About', icon: Info },
    ],
  },
]

const SECTION_META: Record<SectionId, { title: string; subtitle: string }> = {
  general: {
    title: 'General',
    subtitle: 'Choose whether this device hosts the hub or connects to a remote one.',
  },
  access: {
    title: 'Access',
    subtitle: "Share this hub's key so a new runtime can self-register.",
  },
  network: {
    title: 'Network',
    subtitle: 'Tailscale exposure and forward-proxy publishing for this hub and its runtimes.',
  },
  editor: {
    title: 'Editor',
    subtitle: 'Chrome and rendering preferences for the code editor.',
  },
  diagnostics: {
    title: 'Diagnostics',
    subtitle: 'Inspect the local hub process log.',
  },
  about: {
    title: 'About',
    subtitle: 'Version and update status for this device.',
  },
}

function tailscaleLabel(status: TailscaleHubStatus | undefined, isLoading: boolean): { color: string; text: string } {
  if (isLoading || !status) return { color: '#6b7280', text: 'checking…' }
  if (status.ready) return { color: '#56d58a', text: status.url ?? 'ready' }
  if (status.reason === 'not_installed') return { color: '#f87171', text: "Tailscale isn't installed" }
  if (status.reason === 'not_ready') return { color: '#f87171', text: "Tailscale isn't signed in" }
  return { color: '#f87171', text: 'Restart DevDeck to expose this hub' }
}

/** Card wrapping a settings section's body, right pane. */
function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 rounded-xl border border-devdeck-border-card bg-devdeck-surface-2/60 p-5">{children}</div>
  )
}

/** Micro-label + title + description row, with an optional right-aligned action. */
function SectionHeadRow({
  label,
  title,
  description,
  action,
}: {
  label: string
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-dim-2">{label}</div>
        <div className="mt-1 text-[13px] font-semibold text-devdeck-fg">{title}</div>
        {description ? <p className="mt-1 text-[11.5px] text-devdeck-muted-2">{description}</p> : null}
      </div>
      {action ? <div className="flex-none">{action}</div> : null}
    </div>
  )
}

/** Bordered value panel — key field, tailscale status, log row. */
function InsetPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-lg border border-devdeck-border bg-devdeck-terminal p-3.5', className)}>
      {children}
    </div>
  )
}

function Divider() {
  return <div className="my-4 border-t border-devdeck-border" />
}

export function DesktopSettingsDialog() {
  const open = useDevDeckStore((s) => s.desktopSettingsOpen)
  const close = useDevDeckStore((s) => s.closeDesktopSettings)
  const showToast = useDevDeckStore((s) => s.showToast)
  const hubApiKey = useDevDeckStore((s) => s.hubApiKey)
  const tailscaleStatus = useTailscaleStatus(open)
  const machines = useMachines()
  const localMachineId = machines.data?.find((m) => m.isLocal)?.id
  const [confirmingSwitch, setConfirmingSwitch] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [keyRevealed, setKeyRevealed] = useState(false)
  const [section, setSection] = useState<SectionId>('general')
  const [vscodeMode, setVsCodeModeEnabled] = useVsCodeMode()

  function closeDialog() {
    setConfirmingSwitch(false)
    setKeyRevealed(false)
    setSection('general')
    close()
  }

  function copyHubKey() {
    if (!hubApiKey) return
    void navigator.clipboard.writeText(hubApiKey)
    toast.success('Copied')
  }

  function restartToPicker() {
    setSwitching(true)
    changeHub().catch((err) => {
      setSwitching(false)
      showToast(err instanceof Error ? err.message : 'Failed to switch hub mode')
    })
  }

  function onOpenLog() {
    openLogFile().catch((err) => showToast(err instanceof Error ? err.message : 'Failed to open log file'))
  }

  const label = tailscaleLabel(tailscaleStatus.data, tailscaleStatus.isLoading)
  const meta = SECTION_META[section]

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !switching && closeDialog()}
      width={940}
      className="h-[min(620px,82vh)] overflow-hidden p-0"
    >
      <div className="flex h-full min-h-0">
        <nav
          aria-label="Settings navigation"
          className="flex w-[232px] flex-none flex-col overflow-y-auto border-r border-devdeck-border bg-devdeck-surface p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-[720px]:w-14 max-[720px]:px-1.5"
        >
          <button
            type="button"
            aria-label="Back to app"
            onClick={closeDialog}
            className="flex h-9 w-full flex-none items-center gap-2.5 rounded-lg bg-devdeck-surface-2 px-2.5 text-[12.5px] text-devdeck-fg-2 hover:bg-devdeck-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-[720px]:justify-center max-[720px]:px-0"
          >
            <ArrowLeft size={14} className="flex-none" />
            <span className="truncate max-[720px]:hidden">Back to app</span>
          </button>

          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mt-5">
              <div className="mb-1.5 px-2.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-dim-2 max-[720px]:hidden">
                {group.label}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon
                  const active = section === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-label={item.label}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => setSection(item.id)}
                      className={cn(
                        'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                        'max-[720px]:justify-center max-[720px]:px-0',
                        active
                          ? 'border border-devdeck-border-card bg-devdeck-surface-2 text-devdeck-fg'
                          : 'text-devdeck-muted hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2',
                      )}
                    >
                      <Icon size={15} className="flex-none" />
                      <span className="truncate max-[720px]:hidden">{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto bg-devdeck-bg px-[30px] py-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-devdeck-dim-2">Settings</div>
          <DialogTitle className="mt-1 text-[26px] font-bold leading-tight text-devdeck-fg">
            {meta.title}
          </DialogTitle>
          <DialogDescription className="mt-1.5 max-w-[560px] font-sans text-[12.5px] text-devdeck-muted-2">
            {meta.subtitle}
          </DialogDescription>

          <SettingsCard>
            {section === 'general' && (
              <>
                <SectionHeadRow
                  label="Hub mode"
                  title="Hosting location"
                  description="Hosting this hub locally on this device."
                  action={
                    !confirmingSwitch && (
                      <Button variant="secondary" size="sm" onClick={() => setConfirmingSwitch(true)}>
                        Switch to a remote hub…
                      </Button>
                    )
                  }
                />
                {confirmingSwitch && (
                  <>
                    <Divider />
                    <InsetPanel>
                      <div className="mb-2 flex items-center gap-2">
                        <TriangleAlert size={14} className="text-devdeck-yellow-soft" />
                        <span className="font-mono text-[11px] text-devdeck-fg">
                          DevDeck will restart immediately.
                        </span>
                      </div>
                      <p className="mb-3 font-mono text-[10.5px] text-devdeck-dim-2">
                        You&apos;ll be dropped back on the first-run hub picker. Any local sidecar this device is
                        running stops too.
                      </p>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setConfirmingSwitch(false)}
                          disabled={switching}
                        >
                          Cancel
                        </Button>
                        <Button variant="warning" size="sm" onClick={restartToPicker} disabled={switching}>
                          Restart now
                        </Button>
                      </div>
                    </InsetPanel>
                  </>
                )}
              </>
            )}

            {section === 'access' && (
              <>
                <SectionHeadRow
                  label="Hub key"
                  title="Self-registration key"
                  description="Used to self-register a new runtime with this hub — regenerates every restart."
                />
                <Divider />
                {hubApiKey ? (
                  <InsetPanel>
                    <div className="flex items-center gap-3">
                      <span className="w-14 flex-none text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-dim-2">
                        Key
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-devdeck-fg">
                        {keyRevealed ? hubApiKey : MASKED_KEY}
                      </span>
                      <div className="flex flex-none items-center gap-2">
                        <button
                          type="button"
                          aria-label={keyRevealed ? 'Hide hub key' : 'Show hub key'}
                          onClick={() => setKeyRevealed((r) => !r)}
                          className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        >
                          {keyRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                        <button
                          type="button"
                          aria-label="Copy hub key"
                          onClick={copyHubKey}
                          className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        >
                          <Copy size={13} />
                        </button>
                      </div>
                    </div>
                  </InsetPanel>
                ) : (
                  <p className="font-mono text-[11px] text-devdeck-dim-2">Unavailable — reopen from the desktop app.</p>
                )}
              </>
            )}

            {section === 'network' && (
              <>
                <SectionHeadRow label="Network" title="Tailscale" description="Tailscale exposure status for this hub." />
                <Divider />
                <InsetPanel>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-dim-2">
                      Status
                    </span>
                    <span className="inline-flex items-center gap-2 font-mono text-[11px]" style={{ color: label.color }}>
                      <StatusDot color={label.color} size={6} />
                      {label.text}
                    </span>
                  </div>
                </InsetPanel>
                <Divider />
                <SectionHeadRow
                  label="Forward proxy"
                  title="SOCKS5"
                  description="Publish a SOCKS5 proxy on a machine so other tools can route through that machine's network."
                />
                <div className="mt-3">
                  <SocksPublishSection open={open && section === 'network'} />
                </div>
              </>
            )}

            {section === 'editor' && (
              <SectionHeadRow
                label="Editor"
                title="VS Code mode"
                description="Full IDE chrome — minimap, breadcrumbs, sticky scroll, folding and bracket guides. When off, the editor stays minimal: line numbers and syntax only."
                action={
                  <Switch.Root
                    checked={vscodeMode}
                    onCheckedChange={setVsCodeModeEnabled}
                    aria-label="VS Code mode"
                    className={cn(
                      'relative inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full bg-devdeck-surface-2 transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[checked]:bg-devdeck-accent',
                    )}
                  >
                    <Switch.Thumb
                      className={cn(
                        'pointer-events-none block h-3.5 w-3.5 translate-x-1 rounded-full bg-devdeck-fg-2 transition-transform duration-150',
                        'data-[checked]:translate-x-[18px] data-[checked]:bg-devdeck-accent-ink',
                      )}
                    />
                  </Switch.Root>
                }
              />
            )}

            {section === 'diagnostics' && (
              <>
                <SectionHeadRow
                  label="Diagnostics"
                  title="Sidecar log"
                  description="sidecar.log for this device's local hub process."
                />
                <Divider />
                <InsetPanel>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-dim-2">
                      Log file
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-[11px] text-devdeck-fg">sidecar.log</span>
                      <Button variant="secondary" size="sm" onClick={onOpenLog}>
                        Open
                      </Button>
                    </div>
                  </div>
                </InsetPanel>
              </>
            )}

            {section === 'about' && <VersionSection machineId={localMachineId} />}
          </SettingsCard>
        </div>
      </div>
    </Dialog>
  )
}
