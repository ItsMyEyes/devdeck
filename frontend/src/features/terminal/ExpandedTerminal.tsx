import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  ChevronLeft,
  GitBranch,
  PanelRight,
  Search,
  TerminalSquare,
  X,
} from 'lucide-react'
import { STATE } from '@/lib/constants'
import { fmtCost, fmtEl, fmtTok } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Worktree } from '@/store/types'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/ui/pill'
import { StatusDot } from '@/components/ui/status-dot'
import { WorktreeGlyph } from '@/features/agents/WorktreeGlyph'
import { useMachines, useUpdateWorktree, useWorkspace } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'
import type {
  DefinitionReveal,
  DefinitionTarget,
} from './CodeFileEditor'
import { FileEditor } from './FileEditor'
import { FileQuickOpen } from './FileQuickOpen'
import { GitPanel } from './GitPanel'
import { MaterialFileIcon } from './MaterialFileIcon'
import { MobileKeyToolbar } from './MobileKeyToolbar'
import { Terminal, type TerminalHandle } from './Terminal'
import { TerminalExplorer } from './TerminalExplorer'

interface Props {
  worktree: Worktree
  wsId: string
  projectId: string
}

/** Sentinel tab id for the source-control panel; never a real file path. */
const GIT_TAB = '__loom_git__'

function basename(path: string) {
  return path.split('/').pop() ?? path
}

export function ExpandedTerminal({ worktree: w, wsId, projectId }: Props) {
  const navigate = useNavigate()
  const termRef = useRef<TerminalHandle>(null)
  const definitionRequest = useRef(0)
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [showExplorer, setShowExplorer] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [openFiles, setOpenFiles] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState('terminal')
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(() => new Set())
  const [definitionReveals, setDefinitionReveals] = useState<
    Record<string, DefinitionReveal>
  >({})

  const openEdit = useLoomStore((s) => s.openEdit)
  const updateWorktree = useUpdateWorktree()
  const project = useWorkspace(wsId).data?.projects.find(
    (candidate) => candidate.id === projectId,
  )
  const machines = useMachines().data
  const machine = machines?.find((m) => m.id === project?.machineId)
  const askDelete = useLoomStore((s) => s.askDelete)

  function sendKey(data: string) {
    termRef.current?.sendInput(data)
    termRef.current?.focus()
  }

  function approve(ok: boolean) {
    if (!machine) return
    updateWorktree.mutate({
      machine,
      id: w.id,
      patch: ok
        ? {
            state: 'running',
            pending: null,
            appendLine: { k: 'ok', t: '✓ approved — continuing' },
          }
        : {
            state: 'idle',
            pending: null,
            appendLine: { k: 'err', t: '✗ rejected by user — halted' },
          },
    })
  }

  const handleDirtyChange = useCallback((path: string, dirty: boolean) => {
    setDirtyFiles((current) => {
      const next = new Set(current)
      if (dirty) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const openFile = useCallback((path: string) => {
    setOpenFiles((current) =>
      current.includes(path) ? current : [...current, path],
    )
    setActiveTab(path)
    setShowExplorer(false)
  }, [])

  const openDefinition = useCallback(
    (path: string, target: DefinitionTarget) => {
      definitionRequest.current += 1
      setDefinitionReveals((current) => ({
        ...current,
        [path]: { ...target, requestId: definitionRequest.current },
      }))
      openFile(path)
    },
    [openFile],
  )

  const removeOpenedFile = useCallback(
    (path: string) => {
      setDirtyFiles((current) => {
        const next = new Set(current)
        next.delete(path)
        return next
      })
      setDefinitionReveals((current) => {
        const next = { ...current }
        delete next[path]
        return next
      })
      setOpenFiles((current) => {
        const index = current.indexOf(path)
        const next = current.filter((candidate) => candidate !== path)
        if (activeTab === path) {
          setActiveTab(next[index] ?? next[index - 1] ?? 'terminal')
        }
        return next
      })
    },
    [activeTab],
  )

  function closeFile(path: string) {
    if (
      dirtyFiles.has(path) &&
      !window.confirm(`Close ${basename(path)} without saving?`)
    )
      return
    removeOpenedFile(path)
  }

  function back() {
    if (
      dirtyFiles.size > 0 &&
      !window.confirm('Leave this terminal with unsaved files?')
    )
      return
    navigate({ to: '/w/$wsId/p/$projectId', params: { wsId, projectId } })
  }

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setQuickOpen(true)
      } else if (event.ctrlKey && event.key.toLowerCase() === 'w') {
        if (activeTab === 'terminal' || activeTab === GIT_TAB) return
        event.preventDefault()
        closeFile(activeTab)
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [activeTab, dirtyFiles])

  useEffect(() => {
    if (dirtyFiles.size === 0) return
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirtyFiles.size])

  const st = STATE[w.state]
  const label = w.root ? 'project root' : w.branch

  if (!machine) {
    return (
      <div className="flex flex-1 items-center justify-center font-mono text-sm text-loom-dim">
        no machine assigned to this project — add one from the Machines page
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-loom-terminal">
      <div className="flex min-h-[44px] flex-none items-center gap-2 border-b border-loom-border bg-loom-surface px-2.5">
        <Button variant="secondary" size="sm" onClick={back} className="pl-1.5">
          <ChevronLeft size={15} />
          Back
        </Button>
        <StatusDot
          color={st.color}
          pulse={w.state === 'running' || w.state === 'waiting'}
        />
        <WorktreeGlyph root={w.root} size={12} />
        <span className="max-w-[220px] flex-none truncate font-mono text-[12px] font-medium">
          {label}
        </span>
        <Pill color={st.color}>{st.label}</Pill>
        <span className="hidden min-w-[90px] flex-1 truncate whitespace-nowrap font-mono text-[10.5px] text-loom-dim md:block">
          {w.model} · {fmtEl(w.elapsed)} · {fmtTok(w.tokens)} tok ·{' '}
          {fmtCost(w.tokens)}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {w.state === 'waiting' ? (
            <Button variant="warning" size="sm" onClick={() => approve(true)}>
              Approve
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setQuickOpen(true)}
            title="Find file with regex"
          >
            <Search size={13} />
            <span className="max-md:hidden">Find file</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowExplorer((visible) => !visible)}
            className="lg:hidden"
          >
            <PanelRight size={14} />
            Files
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              openEdit('worktree', w.id, {
                a: w.branch,
                b: w.task,
                model: w.model,
              })
            }
            className="max-md:hidden"
          >
            Details
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => askDelete('worktree', w.id, label)}
            className="max-md:hidden"
          >
            Delete
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <section
          className={cn(
            'min-w-0 flex-1 flex-col overflow-hidden',
            showExplorer ? 'hidden lg:flex' : 'flex',
          )}
        >
          <div className="flex h-9 flex-none items-stretch overflow-x-auto border-b border-loom-border bg-loom-surface-2">
            <button
              type="button"
              onClick={() => setActiveTab('terminal')}
              className={cn(
                'flex flex-none cursor-pointer items-center gap-2 border-r border-loom-border px-3 font-mono text-[11px]',
                activeTab === 'terminal'
                  ? 'bg-loom-terminal text-loom-fg'
                  : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg-2',
              )}
            >
              <TerminalSquare size={13} className="text-loom-accent" />
              Terminal
            </button>

            <button
              type="button"
              onClick={() => setActiveTab(GIT_TAB)}
              className={cn(
                'flex flex-none cursor-pointer items-center gap-2 border-r border-loom-border px-3 font-mono text-[11px]',
                activeTab === GIT_TAB
                  ? 'bg-loom-terminal text-loom-fg'
                  : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg-2',
              )}
            >
              <GitBranch size={13} className="text-loom-accent" />
              Git
            </button>

            {openFiles.map((path) => (
              <div
                key={path}
                className={cn(
                  'group flex max-w-[220px] flex-none items-center border-r border-loom-border',
                  activeTab === path
                    ? 'bg-loom-terminal'
                    : 'hover:bg-loom-hover-wash',
                )}
              >
                <button
                  type="button"
                  onClick={() => setActiveTab(path)}
                  title={path}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-0 pl-3 pr-1 font-mono text-[11px] text-loom-fg-2"
                >
                  <MaterialFileIcon name={basename(path)} size={15} />
                  <span className="truncate">{basename(path)}</span>
                  {dirtyFiles.has(path) ? (
                    <span className="text-loom-yellow">*</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={() => closeFile(path)}
                  aria-label={`Close ${basename(path)}`}
                  className="mr-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded text-loom-dim opacity-60 hover:bg-loom-hover-wash hover:text-loom-fg group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              </div>
            ))}

            <span className="min-w-8 flex-1" />
            <span className="hidden flex-none items-center px-3 font-mono text-[9.5px] text-loom-dim xl:flex">
              Ctrl P regex search
            </span>
          </div>

          <div
            className={cn(
              'min-h-0 flex-1 flex-col',
              activeTab === 'terminal' ? 'flex' : 'hidden',
            )}
          >
            <div className="min-h-0 flex-1 overflow-hidden bg-loom-terminal px-3 py-2">
              <Terminal
                key={w.id}
                ref={termRef}
                session={w.id}
                machine={machine}
                ctrlArmed={ctrlArmed}
                onCtrlConsumed={() => setCtrlArmed(false)}
              />
            </div>
            <MobileKeyToolbar
              ctrlArmed={ctrlArmed}
              onToggleCtrl={() => setCtrlArmed((armed) => !armed)}
              onSend={sendKey}
            />
          </div>

          <div
            className={cn(
              'min-h-0 flex-1 flex-col',
              activeTab === GIT_TAB ? 'flex' : 'hidden',
            )}
          >
            <GitPanel worktreeId={w.id} machine={machine} active={activeTab === GIT_TAB} />
          </div>

          {openFiles.map((path) => (
            <FileEditor
              key={path}
              worktreeId={w.id}
              machine={machine}
              path={path}
              active={activeTab === path}
              onDirtyChange={handleDirtyChange}
              onDeleted={removeOpenedFile}
              onOpenDefinition={openDefinition}
              reveal={definitionReveals[path]}
            />
          ))}
        </section>

        <div
          className={cn(
            'min-h-0 w-full flex-col border-l border-loom-border lg:flex lg:w-[300px] lg:flex-none',
            showExplorer ? 'flex' : 'hidden',
          )}
        >
          <TerminalExplorer
            key={w.id}
            worktreeId={w.id}
            machine={machine}
            rootLabel={project?.name ?? label}
            onOpenFile={openFile}
            onFileDeleted={removeOpenedFile}
            onRequestQuickOpen={() => setQuickOpen(true)}
          />
        </div>
      </div>

      <FileQuickOpen
        open={quickOpen}
        worktreeId={w.id}
        machine={machine}
        onClose={() => setQuickOpen(false)}
        onOpenFile={openFile}
      />
    </div>
  )
}
