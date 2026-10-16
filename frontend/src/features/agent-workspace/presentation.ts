import { actorIntent } from '@/features/agent-workspace/activity'
import type { OfficeMember } from '@/features/agent-workspace/model'
import type { OfficeSubagent, OfficeWork } from '@/store/types'
export { characterProfile } from '@/features/agent-workspace/identity'
export const workLabels = {
  generic: 'Working',
  tool: 'Using a tool',
  command: 'Running a command',
  file_change: 'Editing files',
  attention: 'Needs attention',
  error: 'Error',
  unverified: 'Unverified',
  idle: 'Idle',
}
export function workPresentation(member: OfficeMember, child?: string) {
  const intent = actorIntent(member, child)
  const work = child
    ? member.subagents.find((c) => c.id === child)?.work
    : member.work
  const kind =
    intent === 'work'
      ? work?.coverage === 'item_lifecycle' &&
        work.activeCount > 0 &&
        ['tool', 'command', 'file_change'].includes(work.kind)
        ? work.kind
        : 'generic'
      : intent
  return {
    kind,
    label: workLabels[kind],
    count: intent === 'work' ? work?.activeCount || 0 : 0,
  }
}
export function actorWork(
  member: OfficeMember,
  child?: string,
): OfficeWork['kind'] {
  const p = workPresentation(member, child)
  return ['tool', 'command', 'file_change'].includes(p.kind)
    ? (p.kind as OfficeWork['kind'])
    : 'generic'
}
export function visibleOfficeChildren(
  members: OfficeMember[],
  selectedKey?: string,
  selectedChild?: string,
  completed = new Set<string>(),
) {
  const result = new Map<string, OfficeSubagent[]>(
    members.map((m) => [m.key, []]),
  )
  const candidates = members
    .filter((m) => !m.archivedAt)
    .flatMap((m) =>
      m.subagents
        .filter(
          (c) =>
            c.status === 'running' ||
            c.status === 'failed' ||
            completed.has(JSON.stringify([m.key, c.id])),
        )
        .map((c) => ({
          m,
          c,
          priority:
            m.key === selectedKey && c.id === selectedChild
              ? 0
              : c.status === 'failed'
                ? 1
                : c.status === 'running'
                  ? 2
                  : 3,
        })),
    )
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        b.c.updatedAt - a.c.updatedAt ||
        a.m.key.localeCompare(b.m.key) ||
        a.c.id.localeCompare(b.c.id),
    )
  for (const { m, c } of candidates.slice(0, 20)) result.get(m.key)!.push(c)
  // Admission priority must not move furniture when an admitted task updates.
  for (const children of result.values())
    children.sort((a, b) => a.id.localeCompare(b.id))
  return result
}

export function visualStatus(member: OfficeMember, child?: string) {
  if (member.stale || member.limited || member.archivedAt || member.archiving)
    return 'unknown'
  return child
    ? member.subagents.find((c) => c.id === child)?.status || 'unknown'
    : member.status
}
