/**
 * The composer's agent + model picker: a provider rail down the left, a
 * search field, and one row per model.
 *
 * It replaces a ghost pill over a HARDCODED list of four model ids that was
 * never sent anywhere — `sendTurn` dispatched `{ text }` and nothing else, so
 * whatever the pill said, the agent ran its own default. Everything here comes
 * from the machine's real catalog (`useAgents` / `useAgentModels`) and the
 * choice rides the turn as `provider.ModelSelection`.
 *
 * ── Why the rail is agents ──
 * "Model" and "agent" are one choice in this product: a model belongs to a CLI
 * agent, and running it means running that agent. So the rail is the installed
 * agents on this machine and the list is the selected one's models. Picking a
 * model under a different agent switches the thread to it, which starts a
 * fresh provider session — each CLI owns its own conversation, so there is no
 * history to carry across. The row says so before you click.
 *
 * ── Scope ──
 * Favourites (★) are local to this browser: there is no per-user store on the
 * runtime to hang them off, and a favourite is a UI preference, not a fact
 * about the machine. The reference design also groups older models under a
 * "Legacy models" disclosure; nothing in the catalog marks a model legacy, so
 * that group is deliberately absent rather than faked from a name pattern.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Search, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentMark } from '@/features/agent-management/AgentMark'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
import { ComposerControl, ComposerControlChevron } from '@/features/agent-chat/ComposerControl'
import { useAgentModels, useAgents } from '@/features/data/queries'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { AgentModel, AgentSummary, Machine } from '@/store/types'

/** The backend's `InstanceIDForAgent` — `<agent>:default`. Mirrored rather
 *  than fetched: it is a pure naming rule, and the turn payload has to speak
 *  it. Keep in step with `orchestration/thread_instance.go`. */
export function instanceIdForAgent(agentId: string): string {
  return `${agentId || 'claude'}:default`
}

/** Stable key for a favourited model. Agent-qualified because two agents can
 *  legitimately expose the same model id. */
export function favouriteKey(agentId: string, modelId: string): string {
  return `${agentId}:${modelId}`
}

export interface ModelChoice {
  agentId: string
  modelId: string
  /** For the trigger label, so it does not have to re-resolve the catalog. */
  modelName: string
}

export interface ModelPickerProps {
  machine: Machine
  /** The agent this worktree is configured for — the rail's default, and the
   *  one a model is assumed to belong to before the user picks anything. */
  worktreeAgentId: string
  value: ModelChoice | null
  onChange: (choice: ModelChoice) => void
  /** `'menu'` renders a full-width trigger for the overflow popup, matching
   *  the other composer controls. */
  variant?: 'inline' | 'menu'
}

/** ⌘1…⌘9 select the first nine rows, matching the reference. Bound only while
 *  the popup is open, and only on the rows actually rendered — a shortcut that
 *  points at a filtered-out model would be a lie. */
const MAX_SHORTCUTS = 9

function matches(model: AgentModel, query: string): boolean {
  if (query === '') return true
  const q = query.toLowerCase()
  return model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q)
}

function ModelRow({
  model,
  agent,
  selected,
  shortcut,
  favourite,
  switchesAgent,
  onPick,
  onToggleFavourite,
}: {
  model: AgentModel
  agent: { id: string; name: string }
  selected: boolean
  shortcut?: number
  favourite: boolean
  switchesAgent: boolean
  onPick: () => void
  onToggleFavourite: () => void
}) {
  return (
    <div
      className={cn(
        'group flex items-center gap-2 rounded-lg px-2.5 py-2',
        selected ? 'bg-devdeck-hover-wash-menu' : 'hover:bg-devdeck-hover-wash',
      )}
    >
      <button
        type="button"
        onClick={onPick}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left"
      >
        <span className="truncate text-[13.5px] text-devdeck-fg">{model.name}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-devdeck-fg-2">
          <AgentMark id={agent.id} name={agent.name} size="sm" bare />
          <span className="truncate">
            {agent.name}
            {switchesAgent ? ' · starts a new session' : ''}
          </span>
        </span>
      </button>
      {shortcut !== undefined ? (
        <kbd className="flex-none rounded-micro bg-devdeck-raised px-1.5 py-0.5 text-[11px] text-devdeck-fg-2">⌘{shortcut}</kbd>
      ) : null}
      <button
        type="button"
        onClick={onToggleFavourite}
        aria-pressed={favourite}
        aria-label={favourite ? `Unfavourite ${model.name}` : `Favourite ${model.name}`}
        title={favourite ? 'Remove from favourites' : 'Add to favourites'}
        className={cn(
          'flex size-6 flex-none cursor-pointer items-center justify-center rounded-md',
          favourite ? 'text-devdeck-wait' : 'text-devdeck-dim-pane hover:text-devdeck-fg',
        )}
      >
        <Star size={13} fill={favourite ? 'currentColor' : 'none'} aria-hidden="true" />
      </button>
    </div>
  )
}

export function ModelPicker({ machine, worktreeAgentId, value, onChange, variant = 'inline' }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Two independent bits of rail state, not one string. Folding "favourites"
  // into the agent id looked tidier and was wrong: the favourites view still
  // has to know WHICH agent's catalog to filter, and a sentinel id left it
  // with none — the query went disabled and the view was permanently empty.
  const [favouritesView, setFavouritesView] = useState(false)
  const [rail, setRail] = useState<string>(value?.agentId || worktreeAgentId)
  const popupRef = useRef<HTMLDivElement>(null)
  useNativeOverlayBlocker(open, popupRef)

  const favourites = useDevDeckStore((s) => s.favouriteModels)
  const toggleFavouriteModel = useDevDeckStore((s) => s.toggleFavouriteModel)

  const agents = useAgents(machine)
  const installed = useMemo(() => (agents.data ?? []).filter((a: AgentSummary) => a.installed), [agents.data])

  // The rail's own selection, resolved against what is actually installed —
  // a stale agent id (worktree reconfigured, agent uninstalled) must not leave
  // the list permanently empty.
  const activeAgentId = useMemo(() => {
    if (installed.some((a) => a.id === rail)) return rail
    return installed[0]?.id ?? worktreeAgentId
  }, [rail, installed, worktreeAgentId])

  const models = useAgentModels(machine, activeAgentId)

  const agentName = (id: string) => installed.find((a) => a.id === id)?.name ?? id

  // Favourites filter the selected agent's catalog rather than spanning every
  // installed agent: spanning would mean one useAgentModels call per agent,
  // and starring is overwhelmingly used to pin a couple of models WITHIN the
  // provider you work in. The empty copy says which agent it is looking at, so
  // the scope is never a guess.
  const rows: { model: AgentModel; agentId: string }[] = useMemo(() => {
    const list = (models.data ?? [])
      .filter((m) => matches(m, query))
      .filter((m) => !favouritesView || favourites.includes(favouriteKey(activeAgentId, m.id)))
    return list.map((m) => ({ model: m, agentId: activeAgentId }))
  }, [models.data, query, favouritesView, activeAgentId, favourites])

  function pick(agentId: string, model: AgentModel) {
    onChange({ agentId, modelId: model.id, modelName: model.name })
    setOpen(false)
    setQuery('')
  }

  // ⌘1…⌘9. Bound on the document while open rather than on the popup: the
  // search field owns focus the moment the popup mounts, and a keydown there
  // would otherwise never reach a handler on the list.
  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (!event.metaKey && !event.ctrlKey) return
      const n = Number(event.key)
      if (!Number.isInteger(n) || n < 1 || n > MAX_SHORTCUTS) return
      const row = rows[n - 1]
      if (!row) return
      event.preventDefault()
      pick(row.agentId, row.model)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // `pick` is stable enough for this: it closes the popup, which tears the
    // listener down anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows])

  const label = value?.modelName ?? 'Model'

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setRail(value?.agentId || worktreeAgentId)
          setFavouritesView(false)
        } else {
          setQuery('')
        }
      }}
    >
      <Popover.Trigger render={<ComposerControl className={variant === 'menu' ? 'w-full justify-start' : undefined} />}>
        <AgentMark id={value?.agentId || worktreeAgentId} name={agentName(value?.agentId || worktreeAgentId)} size="sm" bare />
        {label}
        <ComposerControlChevron />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} style={{ zIndex: 60 }} className="outline-none">
          <Popover.Popup
            ref={popupRef}
            className={cn(
              'flex h-[360px] w-[460px] origin-[var(--transform-origin)] overflow-hidden rounded-container',
              'border border-devdeck-border-menu bg-devdeck-glass-solid',
              'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            )}
          >
            {/* Rail */}
            <div className="flex w-12 flex-none flex-col items-center gap-1 border-r border-devdeck-hairline py-2">
              <RailButton active={favouritesView} label="Favourites" onClick={() => setFavouritesView((on) => !on)}>
                <Star size={16} fill={favouritesView ? 'currentColor' : 'none'} aria-hidden="true" />
              </RailButton>
              <span aria-hidden="true" className="my-1 h-px w-6 bg-devdeck-hairline" />
              {installed.map((agent) => (
                <RailButton
                  key={agent.id}
                  active={!favouritesView && activeAgentId === agent.id}
                  label={agent.name}
                  onClick={() => {
                    setRail(agent.id)
                    setFavouritesView(false)
                  }}
                >
                  <AgentMark id={agent.id} name={agent.name} active={activeAgentId === agent.id} bare />
                </RailButton>
              ))}
            </div>

            {/* Search + list */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex flex-none items-center gap-2 border-b border-devdeck-ring px-3 py-2.5">
                <Search size={14} className="flex-none text-devdeck-fg-2" aria-hidden="true" />
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search models…"
                  aria-label="Search models"
                  className="min-w-0 flex-1 bg-transparent text-[13.5px] text-devdeck-fg outline-none placeholder:text-devdeck-fg-2"
                />
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
                {agents.isLoading || models.isLoading ? (
                  <PickerNote>Loading models…</PickerNote>
                ) : agents.error || models.error ? (
                  <PickerNote tone="error">Could not load the model catalog.</PickerNote>
                ) : rows.length === 0 ? (
                  <PickerNote>
                    {query
                      ? `No model matches “${query}”.`
                      : favouritesView
                        ? `No favourites in ${agentName(activeAgentId)} yet — star a model to pin it here.`
                        : 'This agent reports no models.'}
                  </PickerNote>
                ) : (
                  rows.map((row, index) => (
                    <ModelRow
                      key={`${row.agentId}:${row.model.id}`}
                      model={row.model}
                      agent={{ id: row.agentId, name: agentName(row.agentId) }}
                      selected={value?.agentId === row.agentId && value?.modelId === row.model.id}
                      shortcut={index < MAX_SHORTCUTS ? index + 1 : undefined}
                      favourite={favourites.includes(favouriteKey(row.agentId, row.model.id))}
                      switchesAgent={row.agentId !== worktreeAgentId}
                      onPick={() => pick(row.agentId, row.model)}
                      onToggleFavourite={() => toggleFavouriteModel(favouriteKey(row.agentId, row.model.id))}
                    />
                  ))
                )}
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** A rail entry. The active one carries a solid accent bar on its left edge —
 *  the reference's marker, and the one piece of state a 40px-wide column can
 *  show without text. */
function RailButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'relative flex size-9 cursor-pointer items-center justify-center rounded-lg',
        active ? 'text-devdeck-fg' : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
      )}
    >
      {active ? (
        <span aria-hidden="true" className="absolute -right-1.5 h-5 w-[3px] rounded-full bg-devdeck-accent" />
      ) : null}
      {children}
    </button>
  )
}

function PickerNote({ tone = 'neutral', children }: { tone?: 'neutral' | 'error'; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'flex flex-1 items-center justify-center px-4 text-center text-[12.5px]',
        tone === 'error' ? 'text-devdeck-err' : 'text-devdeck-fg-2',
      )}
    >
      {children}
    </div>
  )
}
