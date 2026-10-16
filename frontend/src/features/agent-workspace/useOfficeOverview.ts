import { useEffect, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import {
  useMachines,
  useSSHConnections,
  useWhoami,
} from '@/features/data/queries'
import { request } from '@/lib/api'
import { resolveMachineRest } from '@/lib/machineClient'
import { avatarKey, sessionOwner } from '@/features/agent-workspace/model'
import type { OfficeMember } from '@/features/agent-workspace/model'
import type {
  Machine,
  OfficeOverview,
  OfficeSession,
  Workspace,
} from '@/store/types'
import type { AgentThread } from '@/features/data/queries'

export function usePageVisible() {
  const [visible, setVisible] = useState(
    () => document.visibilityState !== 'hidden',
  )
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}
interface Source {
  id: string
  name: string
  machine?: Machine
}
interface Snapshot extends OfficeOverview {
  limited: boolean
  lifecycle: boolean
}

export function useOfficeOverview(workspace: Workspace) {
  const visible = usePageVisible()
  const who = useWhoami()
  const machines = useMachines(who.data?.role !== 'runtime')
  const connections = useSSHConnections()
  const localId =
    who.data?.role === 'runtime' ? who.data.machineId || 'hub' : 'hub'
  const wanted = new Set(
    [
      ...workspace.projects.map((p) => p.machineId),
      ...(connections.data ?? []).map((c) => c.executorMachineId),
    ].filter(Boolean),
  )
  const sources: Source[] = [
    { id: localId, name: who.data?.machineName || 'This server' },
  ]
  for (const machine of machines.data ?? []) {
    if (wanted.has(machine.id) && machine.id !== localId)
      sources.push({ id: machine.id, name: machine.name, machine })
  }
  const queries = useQueries({
    queries: sources.map((source) => ({
      queryKey: ['agent-workspace-overview', workspace.id, source.id],
      enabled: visible && !!who.data,
      queryFn: async ({ signal }): Promise<Snapshot> => {
        const get = async <T>(path: string): Promise<T> => {
          const opts = source.machine
            ? await resolveMachineRest(source.machine)
            : undefined
          const controller = new AbortController()
          const abort = () => controller.abort()
          signal.addEventListener('abort', abort, { once: true })
          const timeout = setTimeout(abort, 5000)
          if (signal.aborted) abort()
          try {
            return await request<T>('GET', path, undefined, {
              ...opts,
              signal: controller.signal,
            })
          } finally {
            clearTimeout(timeout)
            signal.removeEventListener('abort', abort)
          }
        }
        const identity = await get<{ capabilities?: string[] }>('/whoami')
        if (identity.capabilities?.includes('agent-workspace-overview')) {
          const data = await get<OfficeOverview>(
            `/agent/workspace-overview?workspaceId=${encodeURIComponent(workspace.id)}`,
          )
          return {
            ...data,
            limited: false,
            lifecycle: identity.capabilities.includes(
              'agent-session-lifecycle',
            ),
          }
        }
        const scopes = workspace.projects
          .filter((p) => (p.machineId || 'hub') === source.id)
          .flatMap((p) =>
            p.worktrees.map((w) => ({
              id: w.id,
              projectId: p.id,
              worktreeId: w.id,
              connectionId: undefined as string | undefined,
            })),
          )
        scopes.push(
          ...(connections.data ?? [])
            .filter((c) => (c.executorMachineId || 'hub') === source.id)
            .map((c) => ({
              id: `ssh:${c.id}`,
              projectId: '',
              worktreeId: '',
              connectionId: c.id,
            })),
        )
        const batches = await Promise.all(
          scopes.map(async (scope) => {
            const threads = await get<AgentThread[]>(
              `/agent/threads?worktree=${encodeURIComponent(scope.id)}`,
            )
            return (threads ?? []).map(
              (t) =>
                ({
                  id: t.id,
                  characterName: t.characterName,
                  archivedAt: t.archivedAt,
                  archiving: t.archiving,
                  title: t.title,
                  worktreeId: scope.worktreeId,
                  projectId: scope.projectId,
                  connectionId: scope.connectionId,
                  agent: t.agentId,
                  model: t.model,
                  status: t.status === 'waiting' ? 'waiting' : 'unknown',
                  turnInFlight: false,
                  approvals: 0,
                  questions: 0,
                  planReady: t.planReady,
                  activity: 'Limited status · update runtime',
                  updatedAt: t.updatedAt,
                  subagents: [],
                  recent: [],
                }) satisfies OfficeSession,
            )
          }),
        )
        return {
          workspaceId: workspace.id,
          sampledAt: Date.now(),
          sessions: batches.flat(),
          limited: true,
          lifecycle:
            identity.capabilities?.includes('agent-session-lifecycle') ?? false,
        }
      },
      refetchInterval: 2000,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  })
  const members: OfficeMember[] = []
  sources.forEach((source, i) => {
    const query = queries[i]
    for (const session of query.data?.sessions ?? []) {
      if (
        sessionOwner(session, workspace.projects, connections.data ?? []) !==
        source.id
      )
        continue
      members.push({
        ...session,
        receivedAt: query.dataUpdatedAt,
        parentProject: connections.data?.find(
          (c) => c.id === session.connectionId,
        )?.parentProject,
        hostName: connections.data?.find((c) => c.id === session.connectionId)
          ?.name,
        lifecycle: query.data?.lifecycle ?? false,
        key: avatarKey(source.id, session.id),
        sourceId: source.id,
        sourceName: source.name,
        machine: source.machine,
        stale: query.isError || Date.now() - query.dataUpdatedAt > 10_000,
        limited: query.data?.limited ?? false,
      })
    }
  })
  const sourceStates = sources.map((s, i) => ({
    id: s.id,
    name: s.name,
    error: queries[i].isError,
    loading: queries[i].isPending,
    limited: queries[i].data?.limited,
    sampledAt: queries[i].data?.sampledAt,
  }))
  for (const id of wanted)
    if (id && !sources.some((s) => s.id === id))
      sourceStates.push({
        id,
        name: 'Runtime unavailable',
        error: true,
        loading: false,
        limited: undefined,
        sampledAt: undefined,
      })
  return {
    members,
    sources: sourceStates,
    visible,
    loading: queries.some((q) => q.isPending),
    catalogError: who.isError || machines.isError || connections.isError,
    refresh: () => {
      void who.refetch()
      void machines.refetch()
      void connections.refetch()
      queries.forEach((q) => {
        void q.refetch()
      })
    },
  }
}
