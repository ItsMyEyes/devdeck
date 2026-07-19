import { useState } from 'react'
import { Check, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/ui/pill'
import { Select } from '@/components/ui/select'
import { PRI } from '@/lib/constants'
import { cn } from '@/lib/utils'
import type { Priority } from '@/store/types'
import {
  useClearDoneTodos,
  useCreateTodo,
  useDeleteTodo,
  useUpdateTodo,
  useWorkspace,
} from '@/features/data/queries'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import { TodosEmpty } from '@/features/screens/TodosEmpty'
import { ModuleHeader } from './ModuleHeader'

type Filter = 'all' | 'active' | 'done'

const FILTERS: Filter[] = ['all', 'active', 'done']

const PRI_OPTIONS = [
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
]

/** Per-workspace task list with priorities, filters and add/toggle/delete. */
export function TodosModule({ wsId }: { wsId: string }) {
  const q = useWorkspace(wsId)
  const createTodo = useCreateTodo()
  const updateTodo = useUpdateTodo()
  const deleteTodo = useDeleteTodo()
  const clearDone = useClearDoneTodos()

  const [text, setText] = useState('')
  const [pri, setPri] = useState<Priority>('normal')
  const [filter, setFilter] = useState<Filter>('all')

  if (q.isPending) return <DataLoading label="loading todos…" />
  if (q.isError) return <DataError error={q.error} onRetry={() => q.refetch()} />

  const todos = q.data?.todos ?? []
  const doneCount = todos.filter((t) => t.done).length
  const visible = todos.filter((t) =>
    filter === 'active' ? !t.done : filter === 'done' ? t.done : true,
  )

  function add() {
    const t = text.trim()
    if (!t) return
    createTodo.mutate({ wsId, body: { text: t, priority: pri } }, { onSuccess: () => setText('') })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ModuleHeader
        title="Todos"
        meta={todos.length ? `${todos.length - doneCount} active · ${doneCount} done` : undefined}
        actions={
          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-0.5 rounded-lg border border-devdeck-border-strong p-0.5">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    'h-6 rounded-md px-2 font-mono text-[11px] capitalize transition-colors',
                    filter === f
                      ? 'bg-devdeck-popover text-devdeck-fg'
                      : 'text-devdeck-dim hover:text-devdeck-fg-2',
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={!doneCount || clearDone.isPending}
              onClick={() => clearDone.mutate(wsId)}
            >
              Clear done
            </Button>
          </div>
        }
      />

      <div className="flex-none px-4 pt-4">
        <div className="flex items-center gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="Add a task…"
            className="flex-1"
          />
          <div className="w-[118px]">
            <Select
              value={pri}
              onValueChange={(v) => setPri(v as Priority)}
              options={PRI_OPTIONS}
              aria-label="Priority"
            />
          </div>
          <Button size="lg" disabled={!text.trim() || createTodo.isPending} onClick={add}>
            Add
          </Button>
        </div>
      </div>

      {todos.length === 0 ? (
        <TodosEmpty />
      ) : (
        <div className="flex-1 overflow-auto p-4 pt-3">
          {visible.length === 0 ? (
            <div className="py-10 text-center font-mono text-[12px] text-devdeck-dim">nothing here</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {visible.map((t) => {
                const p = PRI[t.priority]
                return (
                  <div
                    key={t.id}
                    className="flex items-center gap-3 rounded-[11px] border border-devdeck-border-card bg-devdeck-card px-3 py-2.5"
                  >
                    <button
                      onClick={() => updateTodo.mutate({ id: t.id, patch: { done: !t.done } })}
                      aria-label={t.done ? 'Mark not done' : 'Mark done'}
                      className={cn(
                        'flex h-[17px] w-[17px] flex-none items-center justify-center rounded-[5px] border transition-colors',
                        t.done
                          ? 'border-devdeck-accent bg-primary text-primary-foreground'
                          : 'border-devdeck-border-strong text-transparent hover:border-devdeck-border-accent',
                      )}
                    >
                      <Check size={11} strokeWidth={3} />
                    </button>
                    <span
                      className={cn(
                        'flex-1 text-[12.5px] leading-snug',
                        t.done ? 'text-devdeck-dim line-through' : 'text-devdeck-fg',
                      )}
                    >
                      {t.text}
                    </span>
                    <Pill color={p.color}>{p.label}</Pill>
                    <button
                      onClick={() => deleteTodo.mutate(t.id)}
                      aria-label="Delete task"
                      className="flex-none cursor-pointer p-1 text-devdeck-muted-2 hover:text-devdeck-red-soft"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
