import { describe, expect, it } from 'vitest'
import {
  avatarKey,
  officeLayout,
  sessionOwner,
  visibleSessions,
} from '@/features/agent-workspace/model'
import type { OfficeSession, Project, SSHConnection } from '@/store/types'
const session = (id: string, status: string): OfficeSession => ({
  id,
  status,
  title: id,
  agent: 'codex',
  model: '',
  turnInFlight: status === 'running',
  approvals: 0,
  questions: 0,
  planReady: false,
  activity: '',
  updatedAt: 1,
  subagents: [],
  recent: [],
})
describe('office model', () => {
  it('keeps every busy session, with recent idle sessions only when requested', () => {
    const sessions = [
      session('old', 'idle'),
      session('work', 'running'),
      session('ask', 'waiting'),
    ]
    expect(visibleSessions(sessions, false).map((s) => s.id)).toEqual([
      'work',
      'ask',
    ])
    expect(visibleSessions(sessions, true)).toHaveLength(3)
  })
  it('keys subagents by source and parent, never provider name', () => {
    expect(avatarKey('a', 't', 'c')).not.toBe(avatarKey('b', 't', 'c'))
    expect(avatarKey('a', 't', 'c')).not.toBe(avatarKey('a', 'u', 'c'))
  })
  it('keeps desk positions stable across status changes and response ordering', () => {
    const a = session('a', 'running'),
      b = session('b', 'idle')
    expect(officeLayout([a, b])).toEqual(
      officeLayout([{ ...b, status: 'running' }, a]),
    )
  })
  it('takes project and SSH executor ownership from catalog instead of a duplicate hub copy', () => {
    const projects = [
      { id: 'p', machineId: 'm', worktrees: [{ id: 'w' }] },
    ] as Project[]
    const connections = [
      { id: 'c', executorMachineId: 'ssh-runtime' },
    ] as SSHConnection[]
    expect(
      sessionOwner(
        { ...session('t', 'idle'), worktreeId: 'w' },
        projects,
        connections,
      ),
    ).toBe('m')
    expect(
      sessionOwner(
        { ...session('ssh:c', 'idle'), connectionId: 'c' },
        projects,
        connections,
      ),
    ).toBe('ssh-runtime')
    expect(
      sessionOwner(
        { ...session('gone', 'idle'), worktreeId: 'deleted' },
        projects,
        connections,
      ),
    ).toBeUndefined()
  })
})

it('gives large project groups enough room before the next row', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    ...session(`a${i}`, 'running'),
    projectId: 'a',
  }))
  const positions = officeLayout([
    ...many,
    { ...session('b', 'running'), projectId: 'b' },
    { ...session('c', 'running'), projectId: 'c' },
  ])
  expect(positions.find((p) => p.id === 'c')!.z).toBeGreaterThan(
    Math.max(...positions.filter((p) => p.group === 'a').map((p) => p.z)) + 2,
  )
})

it('keeps every active agent but bounds idle previews without hiding roster history', () => {
  const busy = Array.from({ length: 25 }, (_, i) =>
    session(`busy${i}`, 'running'),
  )
  const idle = Array.from({ length: 500 }, (_, i) => ({
    ...session(`idle${i}`, 'idle'),
    updatedAt: i,
  }))
  expect(visibleSessions([...busy, ...idle], true)).toHaveLength(25)
  expect(visibleSessions(idle, true)).toHaveLength(20)
  expect(visibleSessions(idle, true)[0].id).toBe('idle499')
})

it('retains existing desk positions when admission changes after a turn finishes', () => {
  const a = session('a', 'running'),
    b = session('b', 'running')
  const initial = officeLayout([a, b])
  const next = officeLayout([b, session('c', 'running')], initial)
  expect(next.find((d) => d.id === 'b')).toEqual(
    initial.find((d) => d.id === 'b'),
  )
  expect(new Set(next.map((d) => `${d.x}:${d.z}`)).size).toBe(next.length)
})

it('keeps a failed subagent in attention after its parent turn finishes', () => {
  const parent = {
    ...session('parent', 'idle'),
    subagents: [
      {
        id: 'child',
        title: 'Inspect',
        role: '',
        activity: '',
        status: 'failed',
        updatedAt: 1,
      },
    ],
  }
  expect(visibleSessions([parent], false)).toEqual([parent])
})
