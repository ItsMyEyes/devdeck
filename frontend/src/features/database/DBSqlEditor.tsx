import { useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { Play, Plus, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  useCreateDBSavedQuery,
  useDBSavedQueries,
  useDeleteDBSavedQuery,
  useRunDBQuery,
  useUpdateDBSavedQuery,
} from '@/features/data/queries'
import { ApiError } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'

export function DBSqlEditor({ connectionId }: { connectionId: string }) {
  const { data: savedQueries } = useDBSavedQueries(connectionId)
  const createSaved = useCreateDBSavedQuery()
  const updateSaved = useUpdateDBSavedQuery()
  const deleteSaved = useDeleteDBSavedQuery()
  const runQuery = useRunDBQuery()
  const showToast = useDevDeckStore((s) => s.showToast)

  const [text, setText] = useState('SELECT 1;')
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function run() {
    setError(null)
    runQuery.mutate(
      { connectionId, sql: text },
      { onError: (err) => setError(err instanceof ApiError ? err.message : 'Query failed') },
    )
  }

  function save() {
    const name = window.prompt('Query name')
    if (!name) return
    createSaved.mutate(
      { connectionId, name, sql: text },
      { onSuccess: (q) => { setActiveSavedId(q.id); showToast(`Saved "${name}"`) } },
    )
  }

  function updateActiveSaved() {
    if (!activeSavedId) return
    updateSaved.mutate({ id: activeSavedId, connectionId, patch: { sql: text } }, { onSuccess: () => showToast('Updated saved query') })
  }

  const result = runQuery.data

  return (
    <div className="flex h-full min-h-0">
      <div className="w-52 flex-none overflow-auto border-r border-devdeck-border-menu p-2">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-devdeck-dim">Saved queries</span>
        </div>
        {(savedQueries ?? []).map((q) => (
          <div key={q.id} className="group mb-0.5 flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-white/[0.04]">
            <button
              type="button"
              onClick={() => { setText(q.sql); setActiveSavedId(q.id) }}
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
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-none items-center gap-1.5 border-b border-devdeck-border-menu px-2 py-1.5">
          <Button size="sm" onClick={run} disabled={runQuery.isPending}>
            <Play size={12} />
            Run
          </Button>
          <Button variant="secondary" size="sm" onClick={activeSavedId ? updateActiveSaved : save}>
            <Save size={12} />
            {activeSavedId ? 'Update' : 'Save'}
          </Button>
          {activeSavedId ? (
            <Button variant="ghost" size="sm" onClick={() => { setActiveSavedId(null); setText('') }}>
              <Plus size={12} />
              New
            </Button>
          ) : null}
        </div>

        <div className="flex-none border-b border-devdeck-border-menu">
          <CodeMirror value={text} height="140px" theme={oneDark} extensions={[sql()]} onChange={setText} />
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
              {result.truncated ? <p className="mt-2 text-[11px] text-devdeck-dim">Showing first {result.rows.length} rows.</p> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
