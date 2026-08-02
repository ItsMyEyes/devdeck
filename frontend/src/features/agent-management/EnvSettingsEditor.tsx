import { useCallback, useRef, useState } from 'react'
import type { editor } from 'monaco-editor/editor'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  useAgentSettingsFile,
  useUpdateAgentSettingsFile,
} from '@/features/data/queries'
import { jsonParseMarker } from '@/features/editor/jsonMarkers'
import { MonacoEditor } from '@/features/editor/MonacoEditor'
import { monaco } from '@/features/editor/monacoSetup'
import { DataLoading } from '@/features/screens/DataLoading'
import { cn } from '@/lib/utils'
import type { Machine } from '@/store/types'

export function EnvSettingsEditor({ machine, agentId }: { machine: Machine; agentId: string }) {
  const isCodex = agentId === 'codex'
  const filename = isCodex ? 'config.toml' : 'settings.json'
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const query = useAgentSettingsFile(machine, agentId)
  const save = useUpdateAgentSettingsFile()

  // `query.data.content` is fine to bind directly to a MonacoEditor `value`
  // ONLY as the seed for a local draft — binding it every render, with no
  // `onChange`, means a background refetch (this query's `staleTime` is only
  // 10s, and the app never overrides TanStack Query's default
  // `refetchOnWindowFocus`) silently calls `instance.setValue()` on top of
  // whatever the user is mid-typing, discarding it with no warning. `draft` +
  // `initializedFor` mirror the load-once pattern `FileEditor.tsx` uses for
  // worktree files: seed once per (machine, agent) identity, then never again
  // for that identity, so later refetches of the *same* file can't clobber
  // live edits. `EnvProfileManagement` renders one persistent
  // `EnvSettingsEditor` and swaps which agent's file it points at without
  // remounting it, so `identity` — not just "has data arrived yet" — is what
  // decides whether a reset is due.
  const identity = `${machine.id}:${agentId}`
  const [initializedFor, setInitializedFor] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  if (identity !== initializedFor) {
    if (query.data) {
      // Adjusting state during render (not in an effect) so the switch to a
      // new agent's file never paints a frame of the previous one's content.
      setDraft(query.data.content)
      setInitializedFor(identity)
    } else if (draft !== '') {
      setDraft('')
    }
  }

  async function handleSave() {
    if (!editorRef.current) return
    const content = draft
    // Validate JSON only for Claude
    if (!isCodex) {
      try {
        JSON.parse(content)
      } catch {
        toast.error('Invalid JSON — fix syntax errors before saving.')
        return
      }
    }
    try {
      await save.mutateAsync({ machine, agentId, content })
      toast.success(isCodex ? 'config.toml saved' : 'settings.json saved')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save settings file')
    }
  }

  // Monaco's JSON language feature is not shipped (see monacoSetup.ts), so a
  // JSON.parse-based marker stands in for the CodeMirror linter — and only for
  // Claude's settings.json. Codex's config.toml is not JSON, so it never had a
  // linter here either.
  const handleMount = useCallback(
    (instance: editor.IStandaloneCodeEditor) => {
      editorRef.current = instance
      if (isCodex) {
        return () => {
          editorRef.current = null
        }
      }

      const model = instance.getModel()
      if (!model) return

      const revalidate = () => {
        const marker = jsonParseMarker(model.getValue())
        monaco.editor.setModelMarkers(
          model,
          'devdeck-json',
          marker
            ? [
                {
                  severity: monaco.MarkerSeverity.Error,
                  message: marker.message,
                  startLineNumber: marker.line,
                  startColumn: marker.column,
                  endLineNumber: marker.line,
                  endColumn: model.getLineMaxColumn(Math.min(marker.line, model.getLineCount())),
                },
              ]
            : [],
        )
      }

      revalidate()
      const sub = model.onDidChangeContent(revalidate)
      return () => {
        editorRef.current = null
        sub.dispose()
        monaco.editor.setModelMarkers(model, 'devdeck-json', [])
      }
    },
    [isCodex],
  )

  return (
    <div className="flex flex-none flex-col md:min-h-0 md:flex-1">
      {/* toolbar */}
      <div className="flex flex-none items-center justify-between border-b border-devdeck-border px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-devdeck-dim">
            ~/.{agentId}/{filename}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[9px]',
              save.isPending || query.isFetching
                ? 'bg-devdeck-yellow-tint text-devdeck-yellow-tint-text'
                : 'bg-devdeck-green-tint text-devdeck-green-soft',
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {query.isFetching ? 'Syncing...' : save.isPending ? 'Saving...' : 'Synced'}
          </span>
        </div>
        <Button variant="secondary" size="sm" disabled={save.isPending || query.isLoading} onClick={handleSave}>
          Save
        </Button>
      </div>

      {/* editor */}
      <div className="flex-1 overflow-hidden">
        {query.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <DataLoading compact label="loading settings…" />
          </div>
        ) : query.isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-[12px] text-devdeck-red-soft">Could not load settings file</p>
            <button
              type="button"
              onClick={() => query.refetch()}
              className="cursor-pointer text-[11px] text-devdeck-accent-soft hover:underline"
            >
              Retry
            </button>
          </div>
        ) : (
          <MonacoEditor
            path={filename}
            modelKey={`env-settings:${machine.id}:${agentId}`}
            value={draft}
            onChange={setDraft}
            language={isCodex ? undefined : 'json'}
            onMount={handleMount}
            ariaLabel={`Edit ${filename} for ${agentId}`}
            className="h-full min-h-0 flex-1 overflow-hidden"
          />
        )}
      </div>
    </div>
  )
}
