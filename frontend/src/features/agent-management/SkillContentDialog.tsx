import { useCallback, useEffect, useMemo, useState } from 'react'
import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { AlertTriangle, FilePenLine, Link2, Loader2, RotateCcw, Save, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  useAgentSkillContent,
  useUpdateAgentSkillContent,
} from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import type { Machine } from '@/store/types'

function useSkillLanguage() {
  const [language, setLanguage] = useState<LanguageSupport | null>(null)

  useEffect(() => {
    let cancelled = false
    const description = LanguageDescription.matchFilename(languages, 'SKILL.md')
    if (!description) return

    void description
      .load()
      .then((support) => {
        if (!cancelled) setLanguage(support)
      })
      .catch(() => {
        if (!cancelled) setLanguage(null)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return language
}

export function SkillContentDialog({
  open,
  machine,
  agentId,
  agentName,
  skillName,
  onOpenChange,
}: {
  open: boolean
  machine: Machine
  agentId: string
  agentName: string
  skillName: string
  onOpenChange: (open: boolean) => void
}) {
  const contentQuery = useAgentSkillContent(machine, agentId, skillName, open)
  const updateContent = useUpdateAgentSkillContent()
  const language = useSkillLanguage()
  const [draft, setDraft] = useState('')
  const [baseline, setBaseline] = useState('')
  const [initialized, setInitialized] = useState(false)
  const dirty = initialized && draft !== baseline
  const readOnly = contentQuery.data?.readOnly ?? true

  useEffect(() => {
    const content = contentQuery.data?.content
    if (content === undefined || (initialized && dirty)) return
    setDraft(content)
    setBaseline(content)
    setInitialized(true)
  }, [contentQuery.data?.content, dirty, initialized])

  const handleSave = useCallback(async () => {
    if (!initialized || !dirty || readOnly || updateContent.isPending) return
    try {
      await updateContent.mutateAsync({ machine, agentId, skillName, content: draft })
      setBaseline(draft)
      toast.success(`${skillName}/SKILL.md saved on ${machine.name}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save SKILL.md')
    }
  }, [agentId, dirty, draft, initialized, machine, readOnly, skillName, updateContent])

  useEffect(() => {
    if (!open) return
    function handleKeydown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [handleSave, open])

  const extensions = useMemo(() => {
    const base = [
      oneDark,
      EditorView.lineWrapping,
      EditorView.editable.of(!readOnly),
      EditorState.readOnly.of(readOnly),
    ]
    return language ? [...base, language] : base
  }, [language, readOnly])

  function requestOpenChange(nextOpen: boolean) {
    if (!nextOpen && dirty && !window.confirm('Discard unsaved SKILL.md changes?')) return
    onOpenChange(nextOpen)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={requestOpenChange}
      width={900}
      className="flex h-[min(82vh,760px)] flex-col overflow-hidden p-0"
    >
      <div className="flex flex-none items-start gap-3 border-b border-loom-border px-4 py-3.5">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-loom-border-accent bg-loom-accent-tint text-loom-accent-soft">
          <FilePenLine size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle className="truncate">{skillName}/SKILL.md</DialogTitle>
            {contentQuery.data?.readOnly ? (
              <span className="rounded-md border border-loom-yellow-tint-border bg-loom-yellow-tint px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-loom-yellow-tint-text">
                Read-only
              </span>
            ) : dirty ? (
              <span className="font-mono text-[9.5px] text-loom-yellow">Modified</span>
            ) : initialized ? (
              <span className="font-mono text-[9.5px] text-loom-green-soft">Synced</span>
            ) : null}
          </div>
          <DialogDescription className="mt-1">
            {agentName} on {machine.name}
          </DialogDescription>
        </div>
        <button
          type="button"
          onClick={() => requestOpenChange(false)}
          aria-label="Close skill editor"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-loom-dim transition-colors hover:bg-loom-hover-wash hover:text-loom-fg"
        >
          <X size={15} />
        </button>
      </div>

      {contentQuery.data?.linked ? (
        <div className="flex flex-none items-start gap-2 border-b border-loom-yellow-tint-border bg-loom-yellow-tint px-4 py-2 text-[11px] leading-relaxed text-loom-yellow-tint-text">
          {contentQuery.data.readOnly ? <AlertTriangle size={13} className="mt-0.5 flex-none" /> : <Link2 size={13} className="mt-0.5 flex-none" />}
          {contentQuery.data.readOnly
            ? 'This linked skill points outside Loom-managed writable skill roots, so it is view-only.'
            : 'This is a linked skill. Saving updates the shared source used by its other installations.'}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 bg-[#090a0c]">
        {contentQuery.isPending ? (
          <div className="flex h-full items-center justify-center">
            <DataLoading compact label="loading SKILL.md…" />
          </div>
        ) : contentQuery.isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <AlertTriangle size={22} className="text-loom-yellow" />
            <p className="max-w-lg font-mono text-[11px] leading-relaxed text-loom-muted">
              {contentQuery.error instanceof Error
                ? contentQuery.error.message
                : 'Could not load SKILL.md'}
            </p>
            <Button variant="secondary" size="sm" onClick={() => contentQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <CodeMirror
            value={draft}
            onChange={setDraft}
            height="100%"
            width="100%"
            aria-label={`Edit ${skillName} SKILL.md for ${agentName}`}
            theme="dark"
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
              highlightActiveLineGutter: true,
              highlightSelectionMatches: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: false,
              tabSize: 2,
            }}
            extensions={extensions}
            className="h-full min-h-0 overflow-hidden text-[12.5px]"
          />
        )}
      </div>

      <div className="flex flex-none items-center gap-2 border-t border-loom-border bg-loom-card px-4 py-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-loom-dim">
          {contentQuery.data?.path ?? 'SKILL.md'}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={!dirty || updateContent.isPending}
          onClick={() => setDraft(baseline)}
        >
          <RotateCcw size={12} />
          Revert
        </Button>
        <Button
          size="sm"
          disabled={!dirty || readOnly || updateContent.isPending}
          onClick={() => void handleSave()}
          title="Save SKILL.md (Ctrl+S)"
        >
          {updateContent.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          {updateContent.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Dialog>
  )
}
