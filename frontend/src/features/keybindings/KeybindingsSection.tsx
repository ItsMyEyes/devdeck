import { Plus, RotateCcw, Search, TriangleAlert } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { KEYBINDING_COMMANDS, KEYBINDING_SECTIONS, SCOPE_LABEL } from '@/features/keybindings/catalog'
import type { KeybindingCommand } from '@/features/keybindings/catalog'
import { chordLabel } from '@/features/keybindings/chord'
import type { Chord } from '@/features/keybindings/chord'
import { ChordPillList } from '@/features/keybindings/ChordPills'
import { ChordRecorder } from '@/features/keybindings/ChordRecorder'
import {
  findConflicts,
  resetAllKeybindings,
  resetKeybinding,
  setKeybinding,
  useKeybindings,
} from '@/features/keybindings/store'
import { cn } from '@/lib/utils'

/** Which row is capturing, and whether the captured chord replaces or appends. */
interface Recording {
  commandId: string
  mode: 'replace' | 'add'
}

function matchesQuery(command: KeybindingCommand, chords: Chord[], query: string): boolean {
  if (!query) return true
  const haystack = [
    command.label,
    command.description,
    command.section,
    SCOPE_LABEL[command.scope],
    ...chords.map(chordLabel),
    ...chords,
  ]
    .join(' ')
    .toLowerCase()
  // Every whitespace-separated term must land somewhere, so "browser zoom"
  // narrows instead of widening the way a single-substring test would.
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term))
}

/**
 * Settings › Keybindings — the full shortcut catalog, rebindable in place.
 *
 * Reads from the same registry the live handlers consult, so a chord changed
 * here is in force on the next keypress without a reload.
 */
export function KeybindingsSection() {
  const { bindings, isCustomized } = useKeybindings()
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<Recording | null>(null)

  const conflicts = useMemo(() => findConflicts(bindings), [bindings])
  const customizedCount = KEYBINDING_COMMANDS.filter((command) => isCustomized(command.id)).length

  const groups = useMemo(() => {
    return KEYBINDING_SECTIONS.map((section) => {
      const commands = KEYBINDING_COMMANDS.filter(
        (command) => command.section === section && matchesQuery(command, bindings[command.id] ?? [], query),
      )
      // One scope per section by construction, which is why the "Active while…"
      // line sits on the heading rather than repeating on all 26 rows.
      return { section, commands, scope: commands[0]?.scope }
    }).filter((group) => group.commands.length > 0)
  }, [bindings, query])

  const handleCapture = useCallback(
    (chord: Chord) => {
      setRecording((current) => {
        if (!current) return null
        const existing = bindings[current.commandId] ?? []
        setKeybinding(current.commandId, current.mode === 'add' ? [...existing, chord] : [chord])
        return null
      })
    },
    [bindings],
  )

  const stopRecording = useCallback(() => setRecording(null), [])

  const matchCount = groups.reduce((total, group) => total + group.commands.length, 0)

  return (
    <div>
      <div className="flex items-center gap-2.5">
        <div className="relative min-w-0 flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-devdeck-fg-2" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands or shortcuts…"
            aria-label="Search keybindings"
            className="pl-8"
          />
        </div>
        <Button
          variant="secondary"
          size="lg"
          disabled={customizedCount === 0}
          onClick={() => {
            setRecording(null)
            resetAllKeybindings()
          }}
          title={
            customizedCount === 0
              ? 'Every shortcut is already at its default'
              : `Restore ${customizedCount} customized shortcut${customizedCount === 1 ? '' : 's'}`
          }
        >
          <RotateCcw size={13} />
          Reset all
        </Button>
      </div>

      <p className="mt-2.5 text-[11.5px] text-devdeck-fg-2">
        {customizedCount === 0
          ? 'All shortcuts are at their shipped defaults. '
          : `${customizedCount} shortcut${customizedCount === 1 ? '' : 's'} customized. `}
        Changes apply immediately and are stored on this device.
      </p>

      {groups.length === 0 ? (
        <div className="mt-6 rounded-lg border border-devdeck-border bg-devdeck-pane px-4 py-8 text-center">
          <div className="text-[12.5px] text-devdeck-fg">No shortcut matches “{query}”.</div>
          <div className="mt-1 text-[11.5px] text-devdeck-fg-2">
            Search by command name, or by the keys themselves — try “cmd k”.
          </div>
        </div>
      ) : (
        <>
          {query ? (
            <div className="mt-3 text-[10.5px] uppercase tracking-[0.14em] text-devdeck-fg-2">
              {matchCount} match{matchCount === 1 ? '' : 'es'}
            </div>
          ) : null}
          {groups.map((group) => (
            <section key={group.section} className="mt-5">
              <div className="mb-1.5">
                <div className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
                  {group.section}
                </div>
                {group.scope ? (
                  <div className="mt-1 text-[11px] text-devdeck-fg-2">
                    {SCOPE_LABEL[group.scope]} Two shortcuts clash only inside this group.
                  </div>
                ) : null}
              </div>
              <div className="overflow-hidden rounded-lg border border-devdeck-border bg-devdeck-pane">
                {group.commands.map((command, index) => (
                  <KeybindingRow
                    key={command.id}
                    command={command}
                    chords={bindings[command.id] ?? []}
                    customized={isCustomized(command.id)}
                    conflictsWith={conflicts[command.id] ?? []}
                    recording={recording?.commandId === command.id ? recording : null}
                    onStartRecording={setRecording}
                    onCapture={handleCapture}
                    onCancelRecording={stopRecording}
                    first={index === 0}
                  />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  )
}

function KeybindingRow({
  command,
  chords,
  customized,
  conflictsWith,
  recording,
  onStartRecording,
  onCapture,
  onCancelRecording,
  first,
}: {
  command: KeybindingCommand
  chords: Chord[]
  customized: boolean
  conflictsWith: string[]
  recording: Recording | null
  onStartRecording: (recording: Recording) => void
  onCapture: (chord: Chord) => void
  onCancelRecording: () => void
  first: boolean
}) {
  function removeChord(chord: Chord) {
    setKeybinding(
      command.id,
      chords.filter((existing) => existing !== chord),
    )
  }

  return (
    <div
      className={cn(
        'group/row flex items-start gap-4 px-3.5 py-3',
        !first && 'border-t border-devdeck-border',
        recording && 'bg-devdeck-accent-tint/40',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12.5px] text-devdeck-fg">{command.label}</span>
          {customized ? (
            <span className="flex-none rounded px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-devdeck-accent ring-1 ring-devdeck-border-accent">
              custom
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-devdeck-fg-2">{command.description}</p>
        {conflictsWith.length > 0 ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-devdeck-wait">
            <TriangleAlert size={12} className="mt-px flex-none" />
            <span>Same shortcut as {conflictsWith.join(', ')} — both fire in this context.</span>
          </p>
        ) : null}
      </div>

      <div className="flex flex-none items-center gap-1.5 pt-0.5">
        {recording ? (
          <ChordRecorder onCapture={onCapture} onCancel={onCancelRecording} />
        ) : (
          <>
            <ChordPillList chords={chords} onRemove={removeChord} />
            <button
              type="button"
              aria-label={chords.length === 0 ? `Set shortcut for ${command.label}` : `Add a shortcut for ${command.label}`}
              title={chords.length === 0 ? 'Set a shortcut' : 'Add another shortcut'}
              onClick={() =>
                onStartRecording({ commandId: command.id, mode: chords.length === 0 ? 'replace' : 'add' })
              }
              className={cn(
                'flex h-[22px] w-[22px] items-center justify-center rounded-[5px]',
                'border border-devdeck-border-strong bg-devdeck-card-wash text-devdeck-fg-2',
                'hover:bg-devdeck-glass-solid hover:text-devdeck-fg',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              )}
            >
              <Plus size={12} />
            </button>
            <button
              type="button"
              aria-label={`Reset ${command.label} to default`}
              title={customized ? 'Reset to default' : 'Already at its default'}
              disabled={!customized}
              onClick={() => resetKeybinding(command.id)}
              className={cn(
                'flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-devdeck-fg-2',
                'hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
                'disabled:pointer-events-none disabled:opacity-25',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              )}
            >
              <RotateCcw size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
