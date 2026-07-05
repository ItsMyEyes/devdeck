import { useEffect, useState } from 'react'
import { Check, ServerCog, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAddAgentMCPServer } from '@/features/data/queries'
import { cn } from '@/lib/utils'
import type { AgentSummary } from '@/store/types'
import { AgentMark } from './AgentMark'

type Transport = 'stdio' | 'http'

export function AddMCPDialog({
  open,
  agents,
  onOpenChange,
}: {
  open: boolean
  agents: AgentSummary[]
  onOpenChange: (open: boolean) => void
}) {
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<Transport>('stdio')
  const [target, setTarget] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [error, setError] = useState('')
  const addServer = useAddAgentMCPServer()

  useEffect(() => {
    if (!open) return
    setSelectedAgents(agents.map((agent) => agent.id))
    setName('')
    setTransport('stdio')
    setTarget('')
    setArgs('')
    setEnv('')
    setError('')
  }, [agents, open])

  function toggleAgent(agentId: string) {
    setSelectedAgents((current) =>
      current.includes(agentId)
        ? current.filter((item) => item !== agentId)
        : [...current, agentId],
    )
  }

  async function submit() {
    const cleanName = name.trim()
    const cleanTarget = target.trim()
    if (!cleanName) {
      setError('Server name is required.')
      return
    }
    if (!cleanTarget) {
      setError(transport === 'stdio' ? 'Command is required.' : 'URL is required.')
      return
    }
    if (selectedAgents.length === 0) {
      setError('Select at least one agent.')
      return
    }

    let environment: Record<string, string>
    try {
      environment = parseEnvironment(env)
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'Invalid environment values.')
      return
    }

    setError('')
    const body = {
      name: cleanName,
      transport,
      command: transport === 'stdio' ? cleanTarget : undefined,
      url: transport === 'http' ? cleanTarget : undefined,
      args:
        transport === 'stdio'
          ? args
              .split('\n')
              .map((item) => item.trim())
              .filter(Boolean)
          : undefined,
      env: transport === 'stdio' ? environment : undefined,
    } as const

    const results = []
    for (const agentId of selectedAgents) {
      try {
        await addServer.mutateAsync({ agentId, body })
        results.push({ agentId, ok: true })
      } catch (mutationError) {
        results.push({ agentId, ok: false, error: mutationError })
      }
    }
    const failed = results.filter((result) => !result.ok)
    if (failed.length > 0) {
      const first = failed[0].error
      setError(first instanceof Error ? first.message : 'Could not add MCP server.')
      if (failed.length < results.length) {
        toast.warning(`${cleanName} was added to ${results.length - failed.length} agents`)
      }
      return
    }

    toast.success(`${cleanName} added to ${results.length} agent${results.length === 1 ? '' : 's'}`)
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={590}
      className="max-h-[calc(100dvh-24px)] overflow-y-auto p-4 sm:p-[21px]"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-loom-border-accent bg-loom-accent-tint text-loom-accent-soft">
          <ServerCog size={17} />
        </div>
        <div>
          <DialogTitle>Add MCP server</DialogTitle>
          <DialogDescription className="mt-1.5 leading-relaxed">
            Loom writes this configuration through each agent&apos;s native CLI.
          </DialogDescription>
        </div>
      </div>

      <div className="mt-5 grid gap-4">
        <fieldset>
          <legend className="mb-2 text-[11.5px] font-medium text-loom-muted">Install in</legend>
          <div className="grid grid-cols-1 gap-1.5 sm:flex sm:flex-wrap">
            {agents.map((agent) => {
              const selected = selectedAgents.includes(agent.id)
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => toggleAgent(agent.id)}
                  className={cn(
                    'flex h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 transition-colors sm:h-8 sm:px-2.5',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    selected
                      ? 'border-loom-border-accent bg-loom-accent-tint text-loom-fg'
                      : 'border-loom-border-card bg-loom-surface-2 text-loom-muted',
                  )}
                >
                  <AgentMark id={agent.id} name={agent.name} size="sm" active={selected} />
                  <span className="text-[11px] font-medium">{agent.name}</span>
                  {selected ? <Check size={11} className="text-loom-accent" /> : null}
                </button>
              )
            })}
          </div>
        </fieldset>

        <label className="grid gap-1.5">
          <span className="text-[11.5px] font-medium text-loom-muted">Server name</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="loom-issues"
            autoComplete="off"
          />
        </label>

        <fieldset>
          <legend className="mb-2 text-[11.5px] font-medium text-loom-muted">Transport</legend>
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-loom-border-card bg-loom-surface-2 p-1">
            {(['stdio', 'http'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTransport(item)}
                className={cn(
                  'min-h-9 cursor-pointer rounded-md px-2 py-1.5 font-mono text-[10.5px] leading-tight transition-colors sm:text-[11px]',
                  transport === item
                    ? 'bg-loom-popover text-loom-fg shadow-[inset_0_0_0_1px_var(--loom-border-strong)]'
                    : 'text-loom-dim hover:text-loom-muted',
                )}
              >
                {item === 'stdio' ? 'Local (stdio)' : 'Remote (HTTP)'}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="grid gap-1.5">
          <span className="text-[11.5px] font-medium text-loom-muted">
            {transport === 'stdio' ? 'Command' : 'Server URL'}
          </span>
          <Input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder={
              transport === 'stdio'
                ? '/path/to/mcp-server'
                : 'https://example.com/mcp'
            }
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        {transport === 'stdio' ? (
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5">
              <span className="text-[11.5px] font-medium text-loom-muted">Arguments</span>
              <textarea
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                placeholder={'One argument per line\n--db\n/path/to/loom.db'}
                rows={4}
                spellCheck={false}
                className={textareaClass}
              />
              <span className="font-mono text-[9.5px] text-loom-dim">One argument per line</span>
            </label>
            <label className="grid gap-1.5">
              <span className="text-[11.5px] font-medium text-loom-muted">
                Environment variables
              </span>
              <textarea
                value={env}
                onChange={(event) => setEnv(event.target.value)}
                placeholder={'API_KEY=value\nREGION=us-east-1'}
                rows={4}
                autoComplete="off"
                spellCheck={false}
                className={textareaClass}
              />
              <span className="font-mono text-[9.5px] text-loom-dim">
                Values are sent directly to the agent CLI
              </span>
            </label>
          </div>
        ) : null}

        <div className="flex items-start gap-2 rounded-lg border border-loom-border-card bg-loom-surface-2 px-3 py-2.5 text-[10.5px] leading-relaxed text-loom-muted-2">
          <ShieldCheck size={14} className="mt-0.5 flex-none text-loom-green-soft" />
          Loom only returns redacted server metadata. Environment values remain in the agent&apos;s
          native configuration.
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-loom-red-tint bg-loom-red-tint-hover px-3 py-2 text-[11px] text-loom-red-soft"
          >
            {error}
          </div>
        ) : null}
      </div>

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <DialogClose
          render={
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              disabled={addServer.isPending}
            />
          }
        >
          Cancel
        </DialogClose>
        <Button
          className="w-full sm:w-auto"
          disabled={addServer.isPending}
          onClick={() => void submit()}
        >
          {addServer.isPending ? 'Adding...' : 'Add server'}
        </Button>
      </div>
    </Dialog>
  )
}

const textareaClass = cn(
  'w-full resize-none rounded-lg border border-loom-border-strong bg-loom-bg px-2.5 py-2',
  'font-mono text-[11px] leading-relaxed text-loom-fg placeholder:text-loom-dim-2',
  'focus-visible:border-loom-border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
)

function parseEnvironment(value: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const separator = line.indexOf('=')
    if (separator <= 0) {
      throw new Error(`Environment line "${line}" must use KEY=value.`)
    }
    const key = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`"${key}" is not a valid environment key.`)
    }
    result[key] = line.slice(separator + 1)
  }
  return result
}
