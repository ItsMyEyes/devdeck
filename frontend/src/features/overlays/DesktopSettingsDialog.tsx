import { Switch } from '@base-ui/react/switch'
import {
  ArrowLeft,
  BrainCog,
  Check,
  Cloud,
  Code2,
  Container,
  Copy,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Keyboard,
  Palette,
  Radio,
  ScrollText,
  Send,
  Settings,
  Sparkles,
  Terminal,
  TriangleAlert,
  UserRound,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { changeHub, openLogFile } from '@/features/desktop/desktopBridge'
import { useMachines } from '@/features/data/queries'
import { useCompletionsConfig, useUpdateCompletionsConfig } from '@/features/editor/useCompletionsConfig'
import { useVsCodeMode } from '@/features/editor/useVsCodeMode'
import { useAutoSaveSetting } from '@/features/editor/useAutoSaveSetting'
import { KeybindingsSection } from '@/features/keybindings/KeybindingsSection'
import { MemoryLocalPanel } from '@/features/memory/MemoryLocalPanel'
import { useMemoryConfig, useTestMemoryConnection, useUpdateMemoryConfig } from '@/features/memory/useMemory'
import { AppearanceSetting } from '@/features/theme/AppearanceSetting'
import type { MemoryConfig } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { AccountSection } from './AccountSection'
import { BindAddressSection } from './BindAddressSection'
import { SocksPublishSection } from './SocksPublishSection'
import { TailscaleServeSection } from './TailscaleServeSection'
import { TelegramPublishSection } from './TelegramSection'
import { VersionSection } from './VersionSection'

const MASKED_KEY = '••••••••••••••••'

type SectionId =
  | 'general'
  | 'account'
  | 'access'
  | 'network'
  | 'published'
  | 'appearance'
  | 'editor'
  | 'keybindings'
  | 'completions'
  | 'memory'
  | 'diagnostics'
  | 'about'

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
      { id: 'account', label: 'Account', icon: UserRound },
      { id: 'access', label: 'Access', icon: KeyRound },
      { id: 'network', label: 'Network', icon: Radio },
      { id: 'published', label: 'Published', icon: Send },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'appearance', label: 'Appearance', icon: Palette },
      { id: 'editor', label: 'Editor', icon: Code2 },
      { id: 'keybindings', label: 'Keybindings', icon: Keyboard },
      { id: 'completions', label: 'Completions', icon: Sparkles },
      { id: 'memory', label: 'Memory', icon: BrainCog },
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
  account: {
    title: 'Account',
    subtitle: 'The email and password you sign in to this hub with from a browser.',
  },
  access: {
    title: 'Access',
    subtitle: "Share this hub's key so a new runtime can self-register.",
  },
  published: {
    title: 'Published',
    subtitle: 'Surface a machine\u2019s agent threads outside DevDeck, so they can be driven from somewhere else.',
  },
  network: {
    title: 'Network',
    subtitle: 'Tailscale exposure and forward-proxy publishing for this hub and its runtimes.',
  },
  appearance: {
    title: 'Appearance',
    subtitle: 'Light or dark, for the whole app — chrome, editor and terminals.',
  },
  editor: {
    title: 'Editor',
    subtitle: 'Chrome and rendering preferences for the code editor.',
  },
  keybindings: {
    title: 'Keybindings',
    subtitle: 'Every keyboard shortcut the app claims, and what each one is bound to.',
  },
  completions: {
    title: 'Completions',
    subtitle: "Bring your own API key for AI-generated ghost-text completions in the code editor.",
  },
  memory: {
    title: 'Memory',
    subtitle: 'A self-hosted Hindsight server giving every agent — every provider, every runtime — one shared, persistent memory.',
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


/** Card wrapping a settings section's body, right pane. */
function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 rounded-xl border border-devdeck-border-card bg-devdeck-card-wash/60 p-5">{children}</div>
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
        <div className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">{label}</div>
        <div className="mt-1 text-[13px] font-semibold text-devdeck-fg">{title}</div>
        {description ? <p className="mt-1 text-[11.5px] text-devdeck-fg-2">{description}</p> : null}
      </div>
      {action ? <div className="flex-none">{action}</div> : null}
    </div>
  )
}

/** Bordered value panel — key field, tailscale status, log row. */
function InsetPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-lg border border-devdeck-border bg-devdeck-pane p-3.5', className)}>
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
  const machines = useMachines()
  const localMachineId = machines.data?.find((m) => m.isLocal)?.id
  const [confirmingSwitch, setConfirmingSwitch] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [keyRevealed, setKeyRevealed] = useState(false)
  const [section, setSection] = useState<SectionId>('general')
  const [vscodeMode, setVsCodeModeEnabled] = useVsCodeMode()
  const [autoSave, setAutoSaveEnabled] = useAutoSaveSetting()
  const { data: completionsConfig } = useCompletionsConfig()
  const updateCompletions = useUpdateCompletionsConfig()
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const { data: memoryConfig } = useMemoryConfig()
  const updateMemory = useUpdateMemoryConfig()
  const testMemory = useTestMemoryConnection()
  const [memoryApiKeyDraft, setMemoryApiKeyDraft] = useState('')
  const [memoryLlmApiKeyDraft, setMemoryLlmApiKeyDraft] = useState('')

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
          className="flex w-[232px] flex-none flex-col overflow-y-auto border-r border-devdeck-border bg-devdeck-pane p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-[720px]:w-14 max-[720px]:px-1.5"
        >
          <button
            type="button"
            aria-label="Back to app"
            onClick={closeDialog}
            className="flex h-9 w-full flex-none items-center gap-2.5 rounded-lg bg-devdeck-card-wash px-2.5 text-[12.5px] text-devdeck-fg-2 hover:bg-devdeck-glass-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-[720px]:justify-center max-[720px]:px-0"
          >
            <ArrowLeft size={14} className="flex-none" />
            <span className="truncate max-[720px]:hidden">Back to app</span>
          </button>

          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mt-5">
              <div className="mb-1.5 px-2.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2 max-[720px]:hidden">
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
                          ? 'border border-devdeck-border-card bg-devdeck-card-wash text-devdeck-fg'
                          : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2',
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

        <div className="flex-1 overflow-y-auto bg-devdeck-pane px-[30px] py-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-devdeck-fg-2">Settings</div>
          <DialogTitle className="mt-1 text-[26px] font-bold leading-tight text-devdeck-fg">
            {meta.title}
          </DialogTitle>
          <DialogDescription className="mt-1.5 max-w-[560px] font-sans text-[12.5px] text-devdeck-fg-2">
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
                        <TriangleAlert size={14} className="text-devdeck-wait" />
                        <span className="font-mono text-[11px] text-devdeck-fg">
                          DevDeck will restart immediately.
                        </span>
                      </div>
                      <p className="mb-3 font-mono text-[10.5px] text-devdeck-fg-2">
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

            {section === 'account' && (
              <>
                <SectionHeadRow
                  label="Operator"
                  title="Sign-in credentials"
                  description="The desktop app signs itself in with the hub key; these are for reaching this hub from a browser instead - over the tailnet, or a bound network address."
                />
                <div className="mt-3">
                  <AccountSection />
                </div>
              </>
            )}

            {section === 'access' && (
              <>
                <SectionHeadRow
                  label="Hub key"
                  title="Self-registration key"
                  description="Used to self-register a new runtime with this hub - regenerates every restart."
                />
                <Divider />
                {hubApiKey ? (
                  <InsetPanel>
                    <div className="flex items-center gap-3">
                      <span className="w-14 flex-none text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
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
                          className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-card-wash text-devdeck-fg-2 hover:bg-devdeck-glass-solid hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        >
                          {keyRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                        <button
                          type="button"
                          aria-label="Copy hub key"
                          onClick={copyHubKey}
                          className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-card-wash text-devdeck-fg-2 hover:bg-devdeck-glass-solid hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        >
                          <Copy size={13} />
                        </button>
                      </div>
                    </div>
                  </InsetPanel>
                ) : (
                  <p className="font-mono text-[11px] text-devdeck-fg-2">Unavailable - reopen from the desktop app.</p>
                )}
              </>
            )}

            {section === 'network' && (
              <>
                <SectionHeadRow
                  label="Network"
                  title="Bind address"
                  description="Which address this device's hub and runtime listen on. Loopback keeps them reachable only from here; anything else exposes them to that network."
                />
                <div className="mt-3">
                  <BindAddressSection />
                </div>
                <Divider />
                <SectionHeadRow
                  label="Network"
                  title="Tailscale"
                  description="Expose this hub on your tailnet, and stop exposing it, without restarting."
                />
                <div className="mt-3">
                  <TailscaleServeSection open={open && section === 'network'} />
                </div>
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

            {section === 'published' && (
              <>
                <SectionHeadRow
                  label="Remote chat"
                  title="Telegram"
                  description="Run a Telegram bot on a machine so its agent threads can be driven from a chat. One bot token per machine - Telegram only lets one process poll a token at a time."
                />
                <div className="mt-3">
                  <TelegramPublishSection open={open && section === 'published'} />
                </div>
                <Divider />
                {/* Named rather than left implicit: this section holds exactly
                    one destination today, and without saying so the page reads
                    as though something failed to load. */}
                <SectionHeadRow
                  label="Segera hadir"
                  title="Destinasi lain"
                  description="Telegram is the only destination for now. Slack, Discord and webhooks are on the list - the bridge underneath is destination-agnostic, so adding one is a renderer plus a transport, not a rewrite."
                />
                <div className="mt-3 rounded-lg border border-dashed border-devdeck-border bg-devdeck-pane/40 px-3.5 py-3">
                  <p className="font-mono text-[11px] text-devdeck-fg-2">Coming soon - currently only Telegram.</p>
                </div>
              </>
            )}

            {section === 'appearance' && (
              <>
                <SectionHeadRow label="Theme" title="Colour scheme" description="DevDeck is dark-only." />
                <SettingsCard>
                  <AppearanceSetting />
                </SettingsCard>
              </>
            )}

            {section === 'editor' && (
              <>
                <SectionHeadRow
                  label="Editor"
                  title="VS Code mode"
                  description="Full IDE chrome - minimap, breadcrumbs, sticky scroll, folding and bracket guides. When off, the editor stays minimal: line numbers and syntax only."
                  action={
                    <Switch.Root
                      checked={vscodeMode}
                      onCheckedChange={setVsCodeModeEnabled}
                      aria-label="VS Code mode"
                      className={cn(
                        'relative inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full bg-devdeck-card-wash transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[checked]:bg-devdeck-run',
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
                <Divider />
                <SectionHeadRow
                  label="Saving"
                  title="Auto-save"
                  description="Writes a file tab shortly after you stop typing, and immediately when the tab goes to the back, the app loses focus, or the tab closes. Never writes over a file something else changed while you had unsaved edits - that still waits for you. When off, files only reach disk on Ctrl+S or the close prompt."
                  action={
                    <Switch.Root
                      checked={autoSave}
                      onCheckedChange={setAutoSaveEnabled}
                      aria-label="Auto-save"
                      className={cn(
                        'relative inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full bg-devdeck-card-wash transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[checked]:bg-devdeck-run',
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
              </>
            )}

            {section === 'keybindings' && (
              <>
                <SectionHeadRow
                  label="Shortcuts"
                  title="Keyboard shortcuts"
                  description="Rebind any command by pressing the keys you want. A shortcut can hold more than one chord, and clearing them all leaves the command unbound."
                />
                <Divider />
                <KeybindingsSection />
              </>
            )}

            {section === 'completions' && (
              <>
                <SectionHeadRow
                  label="AI"
                  title="Inline completions"
                  description="Bring your own API key for AI-generated ghost-text completions in the code editor, grounded against the file's language server."
                  action={
                    <Switch.Root
                      checked={completionsConfig?.enabled ?? false}
                      onCheckedChange={(enabled) => updateCompletions.mutate({ enabled })}
                      aria-label="Enable inline completions"
                      className={cn(
                        'relative inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full bg-devdeck-card-wash transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[checked]:bg-devdeck-run',
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
                <Divider />
                <InsetPanel>
                  <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">Provider</span>
                      <select
                        value={completionsConfig?.provider ?? 'anthropic'}
                        onChange={(e) => updateCompletions.mutate({ provider: e.target.value as 'anthropic' | 'openai-compatible' })}
                        className="rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg"
                      >
                        <option value="anthropic">Anthropic</option>
                        <option value="openai-compatible">OpenAI-compatible</option>
                      </select>
                    </label>
                    {completionsConfig?.provider === 'openai-compatible' && (
                      <label className="flex flex-col gap-1">
                        <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">Base URL</span>
                        <input
                          defaultValue={completionsConfig.baseUrl}
                          onBlur={(e) => updateCompletions.mutate({ baseUrl: e.target.value })}
                          placeholder="https://api.openai.com/v1"
                          className="rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg"
                        />
                      </label>
                    )}
                    <label className="flex flex-col gap-1">
                      <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">Model</span>
                      <input
                        defaultValue={completionsConfig?.model ?? ''}
                        onBlur={(e) => updateCompletions.mutate({ model: e.target.value })}
                        className="rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">API key</span>
                      <div className="flex items-center gap-2">
                        <input
                          type="password"
                          value={apiKeyDraft}
                          onChange={(e) => setApiKeyDraft(e.target.value)}
                          placeholder={completionsConfig?.configured ? 'Configured — enter a new key to replace it' : 'Not configured'}
                          className="min-w-0 flex-1 rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg"
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!apiKeyDraft}
                          onClick={() => {
                            updateCompletions.mutate({ apiKey: apiKeyDraft })
                            setApiKeyDraft('')
                          }}
                        >
                          Save key
                        </Button>
                      </div>
                    </label>
                  </div>
                </InsetPanel>
              </>
            )}

            {section === 'memory' && (
              <>
                <SectionHeadRow
                  label="Memory"
                  title="Persistent agent memory"
                  description="Every provider (claude, codex, opencode, pi) and every runtime this hub knows about recalls from and retains to the same bank — nothing project-specific, nothing per-machine."
                  action={
                    <Switch.Root
                      checked={memoryConfig?.enabled ?? false}
                      onCheckedChange={(enabled) => updateMemory.mutate({ enabled })}
                      aria-label="Enable persistent memory"
                      className={cn(
                        'relative inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full bg-devdeck-card-wash transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[checked]:bg-devdeck-run',
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
                <Divider />

                <InsetPanel>
                  <div className="flex flex-col gap-2.5">
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
                      Deployment
                    </span>
                    <div className="grid grid-cols-3 gap-2">
                      {(
                        [
                          { id: 'manual' as const, label: 'Manual / Cloud', hint: 'Your own server or URL', Icon: Cloud },
                          { id: 'container' as const, label: 'This device (container)', hint: 'docker or podman', Icon: Container },
                          { id: 'baremetal' as const, label: 'This device (bare metal)', hint: 'uvx / pip, no Docker', Icon: Terminal },
                        ]
                      ).map((opt) => {
                        const active = memoryConfig?.hosting === opt.id
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => updateMemory.mutate({ hosting: opt.id })}
                            className={cn(
                              'relative rounded-lg border px-2.5 py-2.5 text-left transition-colors',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                              active
                                ? 'border-devdeck-border-accent bg-devdeck-accent-tint text-devdeck-accent'
                                : 'border-devdeck-border text-devdeck-fg-2 hover:bg-devdeck-hover-wash',
                            )}
                          >
                            {active && (
                              <span className="absolute right-2 top-2 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-devdeck-accent text-devdeck-accent-ink">
                                <Check size={9} strokeWidth={3} />
                              </span>
                            )}
                            <opt.Icon size={16} strokeWidth={1.75} className="mb-1.5" />
                            <div className="text-[11px] font-semibold">{opt.label}</div>
                            <div className="mt-0.5 font-mono text-[9.5px] opacity-80">{opt.hint}</div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </InsetPanel>

                {memoryConfig && memoryConfig.hosting !== 'manual' ? (
                  <MemoryLocalPanel hosting={memoryConfig.hosting} localPort={memoryConfig.localPort} updateMemory={updateMemory} />
                ) : (
                  <InsetPanel>
                    <div className="flex flex-col gap-3">
                      <label className="flex flex-col gap-1">
                        <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
                          Hindsight base URL
                        </span>
                        <input
                          defaultValue={memoryConfig?.baseUrl ?? ''}
                          onBlur={(e) => updateMemory.mutate({ baseUrl: e.target.value })}
                          placeholder="http://127.0.0.1:8888"
                          className="rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
                          Hindsight API key
                        </span>
                        <div className="flex items-center gap-2">
                          <input
                            type="password"
                            value={memoryApiKeyDraft}
                            onChange={(e) => setMemoryApiKeyDraft(e.target.value)}
                            placeholder={memoryConfig?.configured ? 'Configured — enter a new key to replace it' : 'Not configured (loopback deployments may not need one)'}
                            className="min-w-0 flex-1 rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg"
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={!memoryApiKeyDraft}
                            onClick={() => {
                              updateMemory.mutate({ apiKey: memoryApiKeyDraft })
                              setMemoryApiKeyDraft('')
                            }}
                          >
                            Save key
                          </Button>
                        </div>
                      </label>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={testMemory.isPending || !memoryConfig?.baseUrl}
                          onClick={() =>
                            testMemory.mutate(
                              { baseUrl: memoryConfig?.baseUrl ?? '', apiKey: memoryApiKeyDraft },
                              {
                                onSuccess: () => toast.success('Connected to Hindsight'),
                                onError: (err) => toast.error(err instanceof Error ? err.message : 'Connection failed'),
                              },
                            )
                          }
                        >
                          {testMemory.isPending ? 'Testing…' : 'Test connection'}
                        </Button>
                        <span className="font-mono text-[10.5px] text-devdeck-fg-2">
                          Tests whatever is saved above — a base URL edit is saved on blur before testing.
                        </span>
                      </div>
                    </div>
                  </InsetPanel>
                )}

                <InsetPanel>
                  <label className="flex flex-col gap-1">
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">Bank</span>
                    <input
                      defaultValue={memoryConfig?.bankId ?? 'devdeck'}
                      onBlur={(e) => updateMemory.mutate({ bankId: e.target.value })}
                      className="rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg"
                    />
                  </label>
                </InsetPanel>

                <Divider />
                <SectionHeadRow label="Recall & retain" title="Per-turn behaviour" />
                <InsetPanel className="mt-3">
                  <div className="flex flex-col gap-3">
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-[11.5px] text-devdeck-fg">
                        Recall before each turn
                        <span className="block text-[10.5px] text-devdeck-fg-2">
                          Prepend relevant memories to what the agent sees.
                        </span>
                      </span>
                      <Switch.Root
                        checked={memoryConfig?.autoRecall ?? true}
                        onCheckedChange={(autoRecall) => updateMemory.mutate({ autoRecall })}
                        aria-label="Auto-recall before each turn"
                        className={cn(
                          'relative inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full bg-devdeck-card-wash transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[checked]:bg-devdeck-run',
                        )}
                      >
                        <Switch.Thumb
                          className={cn(
                            'pointer-events-none block h-3.5 w-3.5 translate-x-1 rounded-full bg-devdeck-fg-2 transition-transform duration-150',
                            'data-[checked]:translate-x-[18px] data-[checked]:bg-devdeck-accent-ink',
                          )}
                        />
                      </Switch.Root>
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-[11.5px] text-devdeck-fg">
                        Retain after each turn
                        <span className="block text-[10.5px] text-devdeck-fg-2">
                          Store what the user asked and the agent replied.
                        </span>
                      </span>
                      <Switch.Root
                        checked={memoryConfig?.autoRetain ?? true}
                        onCheckedChange={(autoRetain) => updateMemory.mutate({ autoRetain })}
                        aria-label="Auto-retain after each turn"
                        className={cn(
                          'relative inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full bg-devdeck-card-wash transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[checked]:bg-devdeck-run',
                        )}
                      >
                        <Switch.Thumb
                          className={cn(
                            'pointer-events-none block h-3.5 w-3.5 translate-x-1 rounded-full bg-devdeck-fg-2 transition-transform duration-150',
                            'data-[checked]:translate-x-[18px] data-[checked]:bg-devdeck-accent-ink',
                          )}
                        />
                      </Switch.Root>
                    </label>
                    <div className="flex gap-3">
                      <label className="flex flex-1 flex-col gap-1">
                        <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
                          Recall budget
                        </span>
                        <select
                          value={memoryConfig?.recallBudget ?? 'mid'}
                          onChange={(e) => updateMemory.mutate({ recallBudget: e.target.value as 'low' | 'mid' | 'high' })}
                          className="rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg"
                        >
                          <option value="low">Low</option>
                          <option value="mid">Mid</option>
                          <option value="high">High</option>
                        </select>
                      </label>
                      <label className="flex flex-1 flex-col gap-1">
                        <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
                          Max tokens
                        </span>
                        <input
                          type="number"
                          defaultValue={memoryConfig?.maxTokens ?? 1536}
                          onBlur={(e) => updateMemory.mutate({ maxTokens: Number(e.target.value) || 1536 })}
                          className="rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg"
                        />
                      </label>
                    </div>
                  </div>
                </InsetPanel>

                <Divider />
                <SectionHeadRow
                  label="Fact extraction"
                  title="LLM used by Hindsight itself"
                  description="Separate from any coding agent's own model — this is what Hindsight uses to turn a raw turn into structured facts. Point Base URL at ollama/lmstudio to keep transcripts off any third-party API, or at any OpenAI/Anthropic-compatible proxy or gateway."
                />
                <InsetPanel className="mt-3">
                  <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">Provider</span>
                      <select
                        value={memoryConfig?.llmProvider ?? 'openai'}
                        onChange={(e) => updateMemory.mutate({ llmProvider: e.target.value as MemoryConfig['llmProvider'] })}
                        className="rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg"
                      >
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="gemini">Gemini</option>
                        <option value="groq">Groq</option>
                        <option value="ollama">Ollama (local)</option>
                        <option value="lmstudio">LM Studio (local)</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">Model</span>
                      <input
                        defaultValue={memoryConfig?.llmModel ?? ''}
                        onBlur={(e) => updateMemory.mutate({ llmModel: e.target.value })}
                        placeholder="e.g. gpt-5-mini, llama3.1"
                        className="rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
                        Base URL
                      </span>
                      <input
                        defaultValue={memoryConfig?.llmBaseUrl ?? ''}
                        onBlur={(e) => updateMemory.mutate({ llmBaseUrl: e.target.value })}
                        placeholder={
                          memoryConfig?.llmProvider === 'ollama'
                            ? 'http://127.0.0.1:11434'
                            : memoryConfig?.llmProvider === 'lmstudio'
                              ? 'http://127.0.0.1:1234'
                              : 'Leave empty for the provider default, or point at a proxy/gateway'
                        }
                        className="rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
                        LLM API key
                      </span>
                      <div className="flex items-center gap-2">
                        <input
                          type="password"
                          value={memoryLlmApiKeyDraft}
                          onChange={(e) => setMemoryLlmApiKeyDraft(e.target.value)}
                          placeholder="Not needed for ollama/lmstudio"
                          className="min-w-0 flex-1 rounded-md bg-devdeck-card-wash px-2.5 py-1.5 font-mono text-[11px] text-devdeck-fg"
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!memoryLlmApiKeyDraft}
                          onClick={() => {
                            updateMemory.mutate({ llmApiKey: memoryLlmApiKeyDraft })
                            setMemoryLlmApiKeyDraft('')
                          }}
                        >
                          Save key
                        </Button>
                      </div>
                    </label>
                  </div>
                </InsetPanel>
              </>
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
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
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
