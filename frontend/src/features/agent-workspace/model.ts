import type {
  Machine,
  OfficeSession,
  Project,
  SSHConnection,
} from '@/store/types'

export interface OfficeMember extends OfficeSession {
  key: string
  sourceId: string
  sourceName: string
  machine?: Machine
  stale: boolean
  limited: boolean
}
export const needsAttention = (s: OfficeSession) =>
  s.status === 'waiting' ||
  s.status === 'error' ||
  s.planReady ||
  s.subagents.some((c) => c.status === 'failed')
export const isActive = (s: OfficeSession) =>
  s.status === 'running' ||
  needsAttention(s) ||
  s.subagents.some((c) => c.status === 'running')
export function avatarKey(source: string, thread: string, child?: string) {
  return JSON.stringify([source, thread, child ?? ''])
}
export function visibleSessions<T extends OfficeSession>(
  sessions: T[],
  history: boolean,
): T[] {
  const active = sessions.filter(isActive)
  if (!history) return active
  const idle = sessions
    .filter((s) => !isActive(s))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  return [...active, ...idle.slice(0, Math.max(0, 20 - active.length))]
}
export function sessionOwner(
  session: OfficeSession,
  projects: Project[],
  connections: SSHConnection[],
): string | undefined {
  if (session.connectionId) {
    const c = connections.find((c) => c.id === session.connectionId)
    return c ? c.executorMachineId || 'hub' : undefined
  }
  const p = projects.find((p) =>
    p.worktrees.some((w) => w.id === session.worktreeId),
  )
  return p ? p.machineId || 'hub' : undefined
}

export interface DeskPosition {
  id: string
  group: string
  x: number
  z: number
}
export function officeLayout(
  sessions: OfficeSession[],
  previous: DeskPosition[] = [],
): DeskPosition[] {
  const groups = [
    ...new Set(sessions.map((s) => s.projectId || 'shared-ssh')),
  ].sort()
  const grouped = groups.map((group) =>
    sessions
      .filter((s) => (s.projectId || 'shared-ssh') === group)
      .sort((a, b) => a.id.localeCompare(b.id)),
  )
  const positions: DeskPosition[] = []
  let rowZ = -4
  for (let i = 0; i < groups.length; i += 2) {
    for (let column = 0; column < 2 && i + column < groups.length; column++) {
      grouped[i + column].forEach((s, j) =>
        positions.push({
          id: s.id,
          group: groups[i + column],
          x: column * 9 + (j % 3) * 2.5 - 6,
          z: rowZ + Math.floor(j / 3) * 3,
        }),
      )
    }
    rowZ +=
      Math.max(
        2,
        ...grouped.slice(i, i + 2).map((g) => Math.ceil(g.length / 3)),
      ) *
        3 +
      2
  }
  const retained = previous.filter((d) =>
    sessions.some(
      (s) => s.id === d.id && (s.projectId || 'shared-ssh') === d.group,
    ),
  )
  for (const desk of positions) {
    if (retained.some((d) => d.id === desk.id)) continue
    let z = desk.z
    while (
      retained.some(
        (d) => Math.abs(d.x - desk.x) < 2.3 && Math.abs(d.z - z) < 2.9,
      )
    )
      z += 3
    retained.push({ ...desk, z })
  }
  return retained
}
export const statusColor = (status: string) =>
  ({
    running: '#3ea888',
    waiting: '#d99738',
    error: '#dc7068',
    failed: '#dc7068',
    stopped: '#8c94a4',
    idle: '#8295b2',
    completed: '#3ea888',
    unknown: '#8c94a4',
  })[status] ?? '#8c94a4'
export const statusLabel = (s: OfficeSession) =>
  s.questions
    ? 'Answer needed'
    : s.approvals
      ? 'Approval needed'
      : s.planReady
        ? 'Plan ready'
        : ({
            running: 'Working',
            idle: 'Idle',
            waiting: 'Waiting',
            error: 'Error',
            stopped: 'Stopped',
            unknown: 'Unverified',
          }[s.status] ?? s.status)
