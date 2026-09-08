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
import type { AgentSettingsFile, Machine } from '@/store/types'

/** Monaco language for a file's format; TOML has no grammar registered here. */
function editorLanguage(syntax: AgentSettingsFile['syntax'] | undefined) {
  return syntax === 'json' || syntax === 'jsonc' ? 'json' : undefined
}

export function EnvSettingsEditor({ machine, agentId }: { machine: Machine; agentId: string }) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const query = useAgentSettingsFile(machine, agentId)
  const save = useUpdateAgentSettingsFile()

  // Every agent keeps its config somewhere different — ~/.claude/settings.json,
  // ~/.codex/config.toml, ~/.pi/agent/settings.json, ~/.config/opencode/
  // opencode.json(c), ~/.gemini/settings.json — and opencode's even depends on
  // which extension that machine happens to have. Deriving any of that from the
  // agent id here would be a second, drifting copy of what the backend already
  // resolved against the real filesystem, so path and syntax ride along with
  // the content instead.
  const file = query.data
  const path = file?.path ?? ''
  const filename = path.slice(path.lastIndexOf('/') + 1) || 'settings'
  // Only strict JSON gets parse-checked. jsonc (opencode) legally carries
  // comments, which JSON.parse rejects — linting it would block every save of a
  // perfectly valid file.
  const strictJson = file?.syntax === 'json'

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
    if (file) {
      // Adjusting state during render (not in an effect) so the switch to a
      // new agent's file never paints a frame of the previous one's content.
      setDraft(file.content)
      setInitializedFor(identity)
    } else if (draft !== '') {
      setDraft('')
    }
  }

  async function handleSave() {
    if (!editorRef.current) return
    const content = draft
    if (strictJson) {
      try {
        JSON.parse(content)
      } catch {
        toast.error('Invalid JSON - fix syntax errors before saving.')
        return
      }
    }
    try {
      await save.mutateAsync({ machine, agentId, content })
      toast.success(`${filename} saved`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save settings file')
    }
  }

  // Monaco's JSON language feature is not shipped (see monacoSetup.ts), so a
  // JSON.parse-based marker stands in for the CodeMirror linter — and only for
  // strict-JSON files, for the same reason handleSave only validates those.
  const handleMount = useCallback(
    (instance: editor.IStandaloneCodeEditor) => {
      editorRef.current = instance
      if (!strictJson) {
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
    [strictJson],
  )

  return (
    <div className="flex flex-none flex-col md:min-h-0 md:flex-1">
      {/* toolbar */}
      <div className="flex flex-none items-center justify-between border-b border-devdeck-border px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-devdeck-fg-2">
            {path || '…'}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[9px]',
              save.isPending || query.isFetching
                ? 'bg-devdeck-yellow-tint text-devdeck-yellow-tint-text'
                : 'bg-devdeck-green-tint text-devdeck-run',
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
            <p className="text-[12px] text-devdeck-err">Could not load settings file</p>
            <button
              type="button"
              onClick={() => query.refetch()}
              className="cursor-pointer text-[11px] text-devdeck-accent hover:underline"
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
            language={editorLanguage(file?.syntax)}
            onMount={handleMount}
            ariaLabel={`Edit ${filename} for ${agentId}`}
            className="h-full min-h-0 flex-1 overflow-hidden"
          />
        )}
      </div>
    </div>
  )
}
