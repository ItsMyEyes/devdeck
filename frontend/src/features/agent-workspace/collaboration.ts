import type { OfficeMember } from '@/features/agent-workspace/model'
export const collaborationKey = (parent: string, child: string) =>
  JSON.stringify([parent, child])
export class CollaborationTracker {
  private previous = new Map<string, string>()
  private completed = new Map<string, number>()
  private delegated = new Map<string, number>()
  private parents = new Set<string>()
  private freshAfter: number
  constructor(freshAfter = 0) { this.freshAfter = freshAfter }
  update(members: OfficeMember[], now: number) {
    const current = new Map<string, string>()
    const parents = new Set<string>()
    for (const member of members) {
      if (
        member.stale ||
        member.limited ||
        member.archivedAt ||
        member.archiving ||
        (this.freshAfter > 0 && (member.receivedAt || 0) <= this.freshAfter)
      )
        continue
      parents.add(member.key)
      for (const child of member.subagents) {
        const key = collaborationKey(member.key, child.id)
        current.set(key, child.status)
        const previous = this.previous.get(key)
        if (
          this.parents.has(member.key) &&
          child.status === 'running' &&
          previous !== 'running'
        )
          this.delegated.set(key, now + 2000)
        if (previous === 'running' && child.status === 'completed')
          this.completed.set(key, now + 6000)
        if (child.status !== 'completed') this.completed.delete(key)
      }
    }
    for (const map of [this.completed, this.delegated])
      for (const [key, until] of map)
        if (!current.has(key) || now >= until) map.delete(key)
    this.previous = current
    this.parents = parents
    return {
      completed: new Set(this.completed.keys()),
      delegated: new Set(this.delegated.keys()),
    }
  }
}
