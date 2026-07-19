import { useEffect, useMemo, useRef, useState } from 'react'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { linter, lintGutter } from '@codemirror/lint'
import { EditorView, keymap, type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { redo, undo } from '@codemirror/commands'
import { Prec } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import CodeMirror from '@uiw/react-codemirror'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  useAgentSettingsFile,
  useUpdateAgentSettingsFile,
} from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { cn } from '@/lib/utils'
import type { Machine } from '@/store/types'

const explicitHistoryKeymap = Prec.highest(
  keymap.of([
    { key: 'Ctrl-z', run: undo, preventDefault: true },
    { key: 'Ctrl-y', run: redo, preventDefault: true },
    { key: 'Ctrl-Shift-z', run: redo, preventDefault: true },
  ]),
)

const devdeckEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: '#090a0c',
      color: '#d8d8d4',
      fontSize: '12.5px',
    },
    '.cm-scroller': {
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      lineHeight: '1.6',
      overflow: 'auto',
    },
    '.cm-content': {
      minHeight: '100%',
      padding: '12px 0',
      caretColor: '#62d8e8',
    },
    '.cm-line': {
      padding: '0 16px',
    },
    '.cm-gutters': {
      border: 'none',
      borderRight: '1px solid #22252a',
      backgroundColor: '#07080a',
      color: '#626771',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 255, 255, 0.025)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(98, 216, 232, 0.08)',
      color: '#9fe6ef',
    },
    '.cm-cursor': {
      borderLeftColor: '#62d8e8',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(47, 143, 157, 0.34)',
    },
    '.cm-panels': {
      borderColor: '#292b30',
      backgroundColor: '#0d0e10',
      color: '#d8d8d4',
    },
    '.cm-panel.cm-search label, .cm-panel.cm-search input': {
      color: '#d8d8d4',
    },
    '.cm-textfield': {
      border: '1px solid #363940',
      backgroundColor: '#0d0e10',
      color: '#d8d8d4',
    },
    '.cm-button': {
      border: '1px solid #363940',
      backgroundImage: 'none',
      backgroundColor: '#1d1f23',
      color: '#d8d8d4',
    },
    '.cm-tooltip': {
      border: '1px solid #292b30',
      backgroundColor: '#0d0e10',
      color: '#d8d8d4',
    },
  },
  { dark: true },
)

function useFileLanguage(agentId: string) {
  const filename = agentId === 'codex' ? 'config.toml' : 'settings.json'
  const [language, setLanguage] = useState<LanguageSupport | null>(null)

  useEffect(() => {
    let cancelled = false
    setLanguage(null)
    if (agentId !== 'codex') return // JSON is handled directly

    const description = LanguageDescription.matchFilename(languages, filename)
    if (!description) return

    void description
      .load()
      .then((support) => {
        if (!cancelled) setLanguage(support)
      })
      .catch(() => {
        if (!cancelled) setLanguage(null)
      })

    return () => { cancelled = true }
  }, [agentId, filename])

  return language
}

export function EnvSettingsEditor({ machine, agentId }: { machine: Machine; agentId: string }) {
  const isCodex = agentId === 'codex'
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const query = useAgentSettingsFile(machine, agentId)
  const save = useUpdateAgentSettingsFile()
  const fileLanguage = useFileLanguage(agentId)

  const value = query.data?.content ?? ''

  async function handleSave() {
    const view = editorRef.current?.view
    if (!view) return
    const content = view.state.doc.toString()
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

  const extensions = useMemo(() => {
    const base = [
      oneDark,
      devdeckEditorTheme,
      explicitHistoryKeymap,
      lintGutter(),
    ]
    if (isCodex) {
      if (fileLanguage) {
        return [...base, fileLanguage]
      }
      // Fallback: no language extension — plain text
      return base
    }
    // Claude — JSON with linting
    return [
      ...base,
      json(),
      linter(jsonParseLinter(), { delay: 300 }),
    ]
  }, [isCodex, fileLanguage])

  return (
    <div className="flex flex-none flex-col md:min-h-0 md:flex-1">
      {/* toolbar */}
      <div className="flex flex-none items-center justify-between border-b border-devdeck-border px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-devdeck-dim">
            ~/.{agentId}/{isCodex ? 'config.toml' : 'settings.json'}
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
          <CodeMirror
            ref={editorRef}
            value={value}
            height="100%"
            width="100%"
            aria-label={`Edit ${isCodex ? 'config.toml' : 'settings.json'} for ${agentId}`}
            theme="dark"
            basicSetup={{
              lineNumbers: true,
              foldGutter: false,
              highlightActiveLine: true,
              highlightActiveLineGutter: true,
              highlightSelectionMatches: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: false,
              tabSize: 2,
            }}
            extensions={extensions}
            className="h-full min-h-0 flex-1 overflow-hidden"
          />
        )}
      </div>
    </div>
  )
}
