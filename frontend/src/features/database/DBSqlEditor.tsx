import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { MySQL, PostgreSQL, SQLite, sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap } from '@codemirror/view'
import type { EditorView } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { format as formatSQL } from 'sql-formatter'
import { AlignLeft, Download, History, Play, Plus, Save, ScanSearch, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { qk } from '@/features/data/keys'
import {
  useClearDBQueryHistory,
  useCreateDBSavedQuery,
  useDBQueryHistory,
  useDBSavedQueries,
  useDeleteDBSavedQuery,
  useRunDBQuery,
  useUpdateDBSavedQuery,
} from '@/features/data/queries'
import { ApiError } from '@/lib/api'
import type { DBCaps } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { DBEngine } from '@/store/types'
import { resultToCSV, resultToJSON } from './exportClient'
import { buildSQLSchema, firstSQLLine, parseExecutedAt, sqlFormatterLanguage } from './sqlEditorSupport'
import type { CacheEntry } from './sqlEditorSupport'

/** CodeMirror's dialect for an engine — separate from sql-formatter's, which
 *  names the same three things differently (see sqlFormatterLanguage). */
function codeMirrorDialect(engine: DBEngine) {
  switch (engine) {
    case 'postgres':
      return PostgreSQL
    case 'mysql':
      return MySQL
    case 'sqlite':
      return SQLite
  }
}

/** Hands `text` to the browser as a download. The object URL is revoked after
 *  the synthetic click so the Blob is not pinned for the tab's lifetime — a
 *  result set here can be tens of megabytes. */
function downloadText(text: string, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function DBSqlEditor({
  connectionId,
  engine,
  caps,
  onDirtyChange,
}: {
  connectionId: string
  engine: DBEngine
  /** Engine capabilities; undefined while GET /db/engines is in flight, which
   *  is what disables Explain rather than guessing a prefix. */
  caps?: DBCaps
  onDirtyChange?: (dirty: boolean) => void
}) {
  const { data: savedQueries } = useDBSavedQueries(connectionId)
  const createSaved = useCreateDBSavedQuery()
  const updateSaved = useUpdateDBSavedQuery()
  const deleteSaved = useDeleteDBSavedQuery()
  const runQuery = useRunDBQuery()
  const showToast = useDevDeckStore((s) => s.showToast)
  const queryClient = useQueryClient()

  const [text, setText] = useState('SELECT 1;')
  // The text at last save/load — dirty means the editor's text has diverged
  // from it. Reset on save, on update, and when a saved query is loaded.
  const [baseline, setBaseline] = useState('SELECT 1;')
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  // Bumped on editor focus to recompute the autocomplete schema from whatever
  // the cache holds *now* — the object tree may have been expanded since this
  // tab was last touched, and a key *prefix* has no cache subscription.
  const [schemaVersion, setSchemaVersion] = useState(0)

  // Passing '' while the panel is closed disables the query (see
  // useDBQueryHistory's `enabled`), so a tab nobody opened the panel on never
  // fetches; the run mutation still invalidates the key, so reopening refetches.
  const { data: history, isLoading: historyLoading, error: historyError } = useDBQueryHistory(
    showHistory ? connectionId : '',
  )
  const clearHistory = useClearDBQueryHistory()

  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    onDirtyChange?.(text !== baseline)
  }, [text, baseline, onDirtyChange])

  /** The selected text, or '' when the selection is empty. Read from the live
   *  EditorView rather than tracked in state so the toolbar Run button and the
   *  Mod-Enter keymap agree without a render per cursor move. */
  const selectedText = useCallback((): string => {
    const view = viewRef.current
    if (!view) return ''
    const { from, to } = view.state.selection.main
    return from === to ? '' : view.state.sliceDoc(from, to)
  }, [])

  const runSQL = useCallback(
    (statement: string) => {
      const trimmed = statement.trim()
      if (!trimmed) return
      setError(null)
      runQuery.mutate(
        { connectionId, sql: trimmed },
        { onError: (err) => setError(err instanceof ApiError ? err.message : 'Query failed') },
      )
    },
    [connectionId, runQuery],
  )

  /** Runs the selection when there is one, otherwise the whole buffer. */
  const runCurrent = useCallback(() => {
    runSQL(selectedText() || text)
  }, [runSQL, selectedText, text])

  // runCurrent closes over `text`, but the keymap extension must not be
  // rebuilt on every keystroke (CodeMirror reconfigures the whole editor when
  // the extension array's identity changes). A ref keeps the shortcut calling
  // the latest closure with a stable extension.
  const runCurrentRef = useRef(runCurrent)
  runCurrentRef.current = runCurrent

  function explain() {
    if (!caps?.explainPrefix) return
    runSQL(`${caps.explainPrefix} ${(selectedText() || text).trim()}`)
  }

  function formatText() {
    try {
      setText(formatSQL(text, { language: sqlFormatterLanguage(engine) }))
    } catch (err) {
      // A statement the formatter's parser rejects is left exactly as typed —
      // silently mangling half-written SQL is worse than not formatting it.
      showToast(err instanceof Error ? `Could not format: ${err.message.split('\n')[0]}` : 'Could not format SQL')
    }
  }

  function save() {
    const name = window.prompt('Query name')
    if (!name) return
    createSaved.mutate(
      { connectionId, name, sql: text },
      { onSuccess: (q) => { setActiveSavedId(q.id); setBaseline(text); showToast(`Saved "${name}"`) } },
    )
  }

  function updateActiveSaved() {
    if (!activeSavedId) return
    updateSaved.mutate(
      { id: activeSavedId, connectionId, patch: { sql: text } },
      { onSuccess: () => { setBaseline(text); showToast('Updated saved query') } },
    )
  }

  function confirmClearHistory() {
    if (!window.confirm('Clear this connection’s query history? This cannot be undone.')) return
    clearHistory.mutate(connectionId, {
      onError: (err) => showToast(err instanceof ApiError ? err.message : 'Could not clear history'),
    })
  }

  const result = runQuery.data
  const historyRows = history ?? []

  // Autocomplete schema, assembled from the react-query cache only — an editor
  // keystroke must never become a metadata round-trip, and an empty cache
  // degrading to plain keyword completion is correct, not a bug.
  // `schemaVersion` (bumped on focus) is the recompute trigger, since a key
  // *prefix* has no cache subscription to re-render off.
  //
  // Serialized rather than returned as an object so an unchanged cache yields
  // an identical string: the extensions memo below then keeps its identity and
  // CodeMirror is not reconfigured on every single focus.
  const schemaJSON = useMemo(
    () =>
      JSON.stringify(
        buildSQLSchema(
          queryClient.getQueriesData({ queryKey: qk.dbTreeRoot(connectionId) }) as CacheEntry[],
          queryClient.getQueriesData({ queryKey: qk.dbColumnsRoot(connectionId) }) as CacheEntry[],
        ),
      ),
    [connectionId, queryClient, schemaVersion],
  )

  const extensions = useMemo(
    () => [
      sql({ dialect: codeMirrorDialect(engine), schema: JSON.parse(schemaJSON) }),
      // Prec.high so Mod-Enter beats the default keymap's insertNewlineAndIndent.
      Prec.high(keymap.of([{ key: 'Mod-Enter', run: () => { runCurrentRef.current(); return true } }])),
    ],
    [engine, schemaJSON],
  )

  return (
    <div className="flex h-full min-h-0">
      <div className="w-52 flex-none overflow-auto border-r border-devdeck-border-menu p-2">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-devdeck-dim">
            {showHistory ? 'History' : 'Saved queries'}
          </span>
          {showHistory ? (
            <button
              type="button"
              onClick={confirmClearHistory}
              disabled={clearHistory.isPending || historyRows.length === 0}
              className="text-devdeck-dim hover:text-devdeck-red-soft disabled:opacity-40"
              aria-label="Clear history"
              title="Clear history"
            >
              <Trash2 size={11} />
            </button>
          ) : null}
        </div>

        {showHistory ? (
          historyLoading ? (
            <p className="px-1.5 text-[11px] text-devdeck-dim">Loading…</p>
          ) : historyError ? (
            <p className="px-1.5 text-[11px] text-devdeck-red-soft">
              {historyError instanceof Error ? historyError.message : 'Failed to load history'}
            </p>
          ) : historyRows.length === 0 ? (
            <p className="px-1.5 text-[11px] text-devdeck-dim">No queries run yet.</p>
          ) : (
            historyRows.map((h) => {
              const when = parseExecutedAt(h.executedAt)
              return (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setText(h.sql)}
                  title={h.status === 'error' ? h.error : h.sql}
                  className="mb-0.5 block w-full rounded-md px-1.5 py-1 text-left hover:bg-white/[0.04]"
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className={cn(
                        'size-1.5 flex-none rounded-full',
                        h.status === 'success' ? 'bg-devdeck-green' : 'bg-devdeck-red-soft',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-devdeck-fg-2">
                      {firstSQLLine(h.sql, 40)}
                    </span>
                  </span>
                  <span className="ml-3 block truncate text-[10px] text-devdeck-dim-2">
                    {when ? formatDistanceToNow(when, { addSuffix: true }) : 'unknown time'} · {h.elapsedMs} ms
                  </span>
                </button>
              )
            })
          )
        ) : (
          (savedQueries ?? []).map((q) => (
            <div key={q.id} className="group mb-0.5 flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-white/[0.04]">
              <button
                type="button"
                onClick={() => { setText(q.sql); setActiveSavedId(q.id); setBaseline(q.sql) }}
                className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-devdeck-fg-2"
              >
                {q.name}
              </button>
              <button
                type="button"
                onClick={() => deleteSaved.mutate({ id: q.id, connectionId })}
                className="opacity-0 hover:text-devdeck-red-soft group-hover:opacity-100"
                aria-label={`Delete ${q.name}`}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-none items-center gap-1.5 border-b border-devdeck-border-menu px-2 py-1.5">
          <Button
            size="sm"
            onClick={runCurrent}
            disabled={runQuery.isPending}
            title="Run (⌘/Ctrl+Enter) — runs the selection when there is one"
          >
            <Play size={12} />
            Run
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={explain}
            disabled={runQuery.isPending || !caps?.explainPrefix}
            title={caps?.explainPrefix ? `${caps.explainPrefix} the current statement` : 'Engine capabilities unavailable'}
          >
            <ScanSearch size={12} />
            Explain
          </Button>
          <Button variant="secondary" size="sm" onClick={formatText} title="Format SQL">
            <AlignLeft size={12} />
            Format
          </Button>
          <Button variant="secondary" size="sm" onClick={activeSavedId ? updateActiveSaved : save}>
            <Save size={12} />
            {activeSavedId ? 'Update' : 'Save'}
          </Button>
          {activeSavedId ? (
            <Button variant="ghost" size="sm" onClick={() => { setActiveSavedId(null); setText(''); setBaseline('') }}>
              <Plus size={12} />
              New
            </Button>
          ) : null}
          <div className="flex-1" />
          <Button
            variant={showHistory ? 'soft' : 'ghost'}
            size="sm"
            onClick={() => setShowHistory((v) => !v)}
            aria-pressed={showHistory}
            title="Toggle query history"
          >
            <History size={12} />
            History
          </Button>
        </div>

        <div className="flex-none border-b border-devdeck-border-menu">
          <CodeMirror
            value={text}
            height="140px"
            theme={oneDark}
            extensions={extensions}
            onChange={setText}
            onCreateEditor={(view) => { viewRef.current = view }}
            onFocus={() => setSchemaVersion((v) => v + 1)}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {error ? (
            <div className="text-[12px] text-devdeck-red-soft">{error}</div>
          ) : !result ? (
            <div className="text-[12px] text-devdeck-dim">Run a query to see results.</div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full border-collapse font-mono text-[11.5px]">
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c.name} className="border-b border-devdeck-border-menu px-2 py-1 text-left text-devdeck-muted">
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td key={j} className="border-b border-devdeck-border-menu/50 px-2 py-1 text-devdeck-fg-2">
                          {v === null ? <span className="italic text-devdeck-dim-2">null</span> : String(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[11px] text-devdeck-dim">
                  {result.rows.length} {result.rows.length === 1 ? 'row' : 'rows'} · {result.elapsedMs} ms
                  {result.truncated ? ` · truncated (showing the first ${result.rows.length})` : ''}
                </span>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => downloadText(resultToCSV(result), 'query-result.csv', 'text/csv;charset=utf-8')}
                >
                  <Download size={11} />
                  CSV
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => downloadText(resultToJSON(result), 'query-result.json', 'application/json')}
                >
                  <Download size={11} />
                  JSON
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
