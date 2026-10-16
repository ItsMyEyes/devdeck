import { expect, it } from 'vitest'
import {
  visibleOfficeChildren,
  characterProfile,
  workPresentation,
} from '@/features/agent-workspace/presentation'
import {
  daylightAt,
  QualityController,
  qualitySettings,
} from '@/features/agent-workspace/sceneSettings'
import { CollaborationTracker } from '@/features/agent-workspace/collaboration'
import type { OfficeMember } from '@/features/agent-workspace/model'
const member = (id: string, children = 30): OfficeMember => ({
  key: id,
  id,
  sourceId: 'hub',
  sourceName: 'Hub',
  characterName: 'Arka',
  title: 'Task',
  agent: 'codex',
  model: '',
  status: 'running',
  turnInFlight: true,
  approvals: 0,
  questions: 0,
  planReady: false,
  activity: 'Editing files',
  updatedAt: 0,
  stale: false,
  limited: false,
  recent: [],
  subagents: Array.from({ length: children }, (_, i) => ({
    id: `c${i}`,
    title: 'Review',
    role: 'Reviewer',
    status: i === 25 ? 'failed' : 'running',
    activity: '',
    updatedAt: i,
  })),
})
it('budgets twenty children globally, pinning selection before failed and running', () => {
  const result = visibleOfficeChildren([member('a'), member('b')], 'b', 'c29')
  expect([...result.values()].flat()).toHaveLength(20)
  expect(result.get('b')!.some((c) => c.id === 'c29')).toBe(true)
  expect(result.get('a')!.some((c) => c.id === 'c25')).toBe(true)
  expect(result.get('b')!.some((c) => c.id === 'c25')).toBe(true)
})
it('uses verified semantic work, never the last activity text', () => {
  const m = member('a', 0)
  expect(workPresentation(m).kind).toBe('generic')
  m.work = { kind: 'command', activeCount: 2, coverage: 'item_lifecycle' }
  expect(workPresentation(m)).toMatchObject({
    kind: 'command',
    count: 2,
    label: 'Running a command',
  })
  m.stale = true
  expect(workPresentation(m).kind).toBe('unverified')
  m.stale = false
  m.status = 'waiting'
  m.approvals = 1
  expect(workPresentation(m).kind).toBe('attention')
})
it('keeps cosmetics deterministic', () => {
  expect(characterProfile('same')).toEqual(characterProfile('same'))
  expect(characterProfile('same')).not.toEqual(characterProfile('different'))
})
it('uses device-local clock periods', () => {
  for (const [hour, period] of [
    [0, 'night'],
    [6, 'morning'],
    [11, 'day'],
    [15, 'evening'],
    [18, 'night'],
  ] as const)
    expect(daylightAt(new Date(2026, 9, 16, hour)).period).toBe(period)
  expect(daylightAt(new Date(2026, 9, 16, 12)).sun).toBeGreaterThan(
    daylightAt(new Date(2026, 9, 16, 23)).sun,
  )
})
it('adapts quality after sustained thresholds and resets hidden samples', () => {
  const q = new QualityController()
  for (let i = 0; i < 125; i++) q.sample(1 / 25)
  expect(q.tier).toBe('low')
  for (let i = 0; i < 15 * 60; i++) q.sample(1 / 60)
  expect(q.tier).toBe('balanced')
  q.reset()
  for (let i = 0; i < 4 * 20; i++) q.sample(1 / 20)
  expect(q.tier).toBe('balanced')
  expect(qualitySettings.low).toMatchObject({
    dpr: 1,
    shadows: false,
    decorativeMotion: false,
  })
})
it('observes six-second completion without replaying initial results', () => {
  const tracker = new CollaborationTracker()
  const m = member('a', 1)
  m.subagents[0].status = 'completed'
  expect(tracker.update([m], 0).completed.size).toBe(0)
  m.subagents[0].status = 'running'
  expect(tracker.update([m], 1).delegated.size).toBe(1)
  m.subagents[0].status = 'completed'
  expect(tracker.update([m], 2).completed.size).toBe(1)
  expect(tracker.update([m], 6001).completed.size).toBe(1)
  expect(tracker.update([m], 6002).completed.size).toBe(0)
  expect(tracker.update([m], 7000).completed.size).toBe(0)
})
it('does not celebrate results inferred across stale observations', () => {
  const tracker = new CollaborationTracker(),
    m = member('a', 1)
  tracker.update([m], 0)
  m.stale = true
  tracker.update([m], 1)
  m.stale = false
  m.subagents[0].status = 'completed'
  expect(tracker.update([m], 2).completed.size).toBe(0)
})
it('uses sustained average FPS rather than resetting on a single fast frame', () => {
  const q = new QualityController()
  for (let i = 0; i < 110; i++) {
    q.sample(1 / 20)
    q.sample(1 / 60)
  }
  expect(q.tier).toBe('low')
})
it('keeps legacy and archiving indicators neutral even when cached status says running', async () => {
  const { visualStatus } =
    await import('@/features/agent-workspace/presentation')
  expect(visualStatus(member('a'))).toBe('running')
  expect(visualStatus({ ...member('a'), limited: true })).toBe('unknown')
  expect(visualStatus({ ...member('a'), archiving: true })).toBe('unknown')
  expect(visualStatus({ ...member('a'), stale: true }, 'c0')).toBe('unknown')
})
it('waits for a fresh receipt after visibility resumes without replaying hidden completion', () => {
  const tracker = new CollaborationTracker(100),
    m = member('a', 1)
  m.receivedAt = 99
  tracker.update([m], 0)
  m.receivedAt = 101
  m.subagents[0].status = 'completed'
  expect(tracker.update([m], 1).completed.size).toBe(0)
  m.receivedAt = 102
  m.subagents[0].status = 'running'
  expect(tracker.update([m], 2).delegated.size).toBe(1)
})

it('keeps admitted companion slots stable across progress and selection updates', () => {
  const m = member('a', 3)
  const before = visibleOfficeChildren([m])
    .get(m.key)!
    .map((c) => c.id)
  m.subagents[0].updatedAt = 100
  const after = visibleOfficeChildren([m], m.key, 'c1')
    .get(m.key)!
    .map((c) => c.id)
  expect(after).toEqual(before)
})
