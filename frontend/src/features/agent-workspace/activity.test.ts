import { describe, expect, it } from 'vitest'
import {
  ActivityWorld,
  activities,
  actorId,
  actorIntent,
  actualSelection,
  clearSegment,
  companionHome,
  findPath,
  floorPlan,
  makeActor,
  walkable,
} from '@/features/agent-workspace/activity'
import type { FloorPlan, Intent } from '@/features/agent-workspace/activity'
import { officeLayout } from '@/features/agent-workspace/model'
import type { OfficeMember } from '@/features/agent-workspace/model'

const member = (changes: Partial<OfficeMember> = {}): OfficeMember => ({
  key: 'parent',
  id: 'thread',
  sourceId: 'hub',
  sourceName: 'Local',
  title: '',
  agent: 'claude',
  model: '',
  status: 'idle',
  turnInFlight: false,
  questions: 0,
  approvals: 0,
  planReady: false,
  activity: '',
  updatedAt: 0,
  subagents: [],
  recent: [],
  stale: false,
  limited: false,
  ...changes,
})
const plan: FloorPlan = {
  minX: -10,
  maxX: 10,
  minZ: -10,
  maxZ: 10,
  obstacles: [],
  slots: [{ id: 'coffee', activity: 'coffee', point: [3, 3], seated: false }],
}
const advance = (world: ActivityWorld, seconds: number) => {
  for (let i = 0; i < seconds * 20; i++) world.tick(0.05, true, false)
}
function world(intent: Intent = 'idle') {
  const value = new ActivityWorld(plan)
  value.reconcile([{ key: 'parent', home: [0, 0], intent }])
  return value
}

describe('office activity truth', () => {
  it('only relaxes a verified idle session without work or requests', () => {
    expect(actorIntent(member())).toBe('idle')
    expect(actorIntent(member({ status: 'running', turnInFlight: true }))).toBe(
      'work',
    )
    for (const changes of [
      { status: 'running' },
      { turnInFlight: true },
      { status: 'stopped' },
      { stale: true },
      { limited: true },
      { archivedAt: 1 },
      { archiving: true },
    ])
      expect(actorIntent(member(changes))).toBe('unverified')
    expect(actorIntent(member({ questions: 1 }))).toBe('attention')
    expect(actorIntent(member({ approvals: 1 }))).toBe('attention')
    expect(actorIntent(member({ planReady: true }))).toBe('attention')
    expect(actorIntent(member({ status: 'error' }))).toBe('error')
    expect(
      actorIntent(member({ stale: true, status: 'waiting', questions: 1 })),
    ).toBe('unverified')
  })
  it('distinguishes a child from its parent and respects disconnected sources', () => {
    const parent = member({
      subagents: [{ id: 'child', status: 'running' }],
    } as Partial<OfficeMember>)
    expect(actorIntent(parent)).toBe('unverified')
    expect(actorIntent(parent, 'child')).toBe('work')
    expect(actorIntent({ ...parent, stale: true }, 'child')).toBe('unverified')
    expect(actorId(parent, 'child')).not.toBe(
      actorId({ ...parent, sourceId: 'runtime' }, 'child'),
    )
    parent.subagents[0].status = 'failed'
    expect(actorIntent(parent, 'child')).toBe('error')
    expect(actorIntent(parent)).toBe('error')
  })
})

describe('office routine lifecycle', () => {
  it('uses stable varied dwell times and never leaves before eight seconds', () => {
    const a = makeActor('a', [0, 0], 'idle'),
      b = makeActor('b', [0, 0], 'idle')
    expect(a.dwell).toBe(makeActor('a', [0, 0], 'idle').dwell)
    expect(a.dwell).not.toBe(b.dwell)
    expect(a.dwell).toBeGreaterThanOrEqual(8)
    expect(a.dwell).toBeLessThanOrEqual(15)
    const w = world()
    advance(w, 7.9)
    expect(w.actors.get('parent')?.phase).toBe('dwell')
    advance(w, 8)
    const actor = w.actors.get('parent')!
    expect(actor.activity).toBe('coffee')
    expect(w.reservations.get('coffee')).toBe('parent')
    expect(actor.duration).toBeGreaterThanOrEqual(20)
    expect(actor.duration).toBeLessThanOrEqual(60)
  })
  it('reserves each destination once and falls back to a different desk activity', () => {
    const w = world()
    w.reconcile([
      { key: 'parent', home: [0, 0], intent: 'idle' },
      { key: 'second', home: [-2, 0], intent: 'idle' },
    ])
    advance(w, 16)
    expect(w.reservations.size).toBe(1)
    expect(
      [...w.actors.values()].filter((a) => a.slot === 'coffee'),
    ).toHaveLength(1)
    expect([...w.actors.values()].find((a) => !a.slot)?.activity).toBe('book')
    const desk = new ActivityWorld({ ...plan, slots: [] })
    desk.reconcile([{ key: 'parent', home: [0, 0], intent: 'idle' }])
    desk.actors.get('parent')!.last = 'book'
    advance(desk, 16)
    expect(desk.actors.get('parent')!.activity).toBe('stretch')
    expect(desk.actors.get('parent')!.seated).toBe(false)
  })
  it.each(['approach', 'setup', 'perform'] as const)(
    'interrupts %s promptly while preserving immediate work intent',
    (phase) => {
      const w = world(),
        actor = w.actors.get('parent')!
      actor.position = [3, 3]
      actor.phase = phase
      actor.activity = 'coffee'
      actor.slot = 'coffee'
      w.reservations.set('coffee', actor.key)
      w.reconcile([{ key: actor.key, home: [0, 0], intent: 'work' }])
      expect(actor.intent).toBe('work')
      expect(actor.phase).toBe('cleanup')
      advance(w, 0.3)
      expect(actor.phase).toBe('return')
      expect(w.reservations.size).toBe(0)
      advance(w, 2)
      expect(actor.position).toEqual([0, 0])
      expect(actor.phase).toBe('dwell')
    },
  )
  it.each(activities)(
    'interrupts %s without delaying status or leaving a reservation',
    (activity) => {
      const w = world(),
        actor = w.actors.get('parent')!
      actor.position = [3, 3]
      actor.activity = activity
      actor.phase = 'perform'
      actor.interaction = 1
      actor.slot = 'coffee'
      w.reservations.set('coffee', actor.key)
      w.reconcile([{ key: actor.key, home: [0, 0], intent: 'attention' }])
      expect(actor.intent).toBe('attention')
      expect(actor.phase).toBe('cleanup')
      advance(w, 3)
      expect(actor.position).toEqual(actor.home)
      expect(w.reservations.size).toBe(0)
    },
  )
  it('releases reservations on archive/filter/floor loss and on changed desk layout', () => {
    const w = world()
    advance(w, 16)
    expect(w.reservations.size).toBe(1)
    const actor = w.actors.get('parent')!
    w.reconcile([{ key: actor.key, home: [0, 0], intent: 'idle' }])
    expect(w.actors.get('parent')).toBe(actor)
    w.reconcile([{ key: actor.key, home: [-2, 0], intent: 'idle' }])
    expect(w.reservations.size).toBe(0)
    expect(actor.position).toEqual([-2, 0])
    actor.slot = 'coffee'
    w.reservations.set('coffee', actor.key)
    w.reconcile([])
    expect(w.actors.size).toBe(0)
    expect(w.reservations.size).toBe(0)
  })
  it('pauses hidden/reduced time and clamps a resumed frame without catchup', () => {
    const w = world(),
      actor = w.actors.get('parent')!
    w.tick(50, false, false)
    w.tick(50, true, true)
    expect(actor.time).toBe(0)
    w.tick(50, true, false)
    expect(actor.time).toBe(0.1)
    advance(w, 16)
    w.resetMotion()
    expect(actor.position).toEqual(actor.home)
    expect(actor.activity).toBeUndefined()
    expect(w.reservations.size).toBe(0)
  })
})

describe('navigation and selection', () => {
  it('routes every desk to every lounge around furniture on both floors', () => {
    const layout = officeLayout(
      Array.from({ length: 20 }, (_, i) =>
        member({ id: `m${i}`, projectId: 'p' }),
      ),
    )
    const maxZ = Math.max(5, ...layout.map((d) => d.z + 3))
    for (const server of [false, true]) {
      const p = floorPlan(
        layout,
        -9,
        Math.max(8, ...layout.map((d) => d.x + 2)),
        -7,
        maxZ,
        server,
      )
      for (const desk of layout)
        for (const slot of p.slots) {
          const home: [number, number] = [desk.x, desk.z + 0.38],
            path = findPath(home, slot.point, p)
          expect(path.length, `${desk.id} -> ${slot.id}`).toBeGreaterThan(0)
          let at = home
          for (const point of path) {
            expect(clearSegment(at, point, p)).toBe(true)
            expect(walkable(point, p)).toBe(true)
            at = point
          }
        }
      expect(walkable(companionHome(layout[0], 0), p)).toBe(true)
    }
  })
  it('yields instead of stacking when two actors cross a narrow route', () => {
    const w = new ActivityWorld(plan)
    w.reconcile([
      { key: 'a', home: [2, 0], intent: 'work' },
      { key: 'b', home: [-2, 0], intent: 'work' },
    ])
    const a = w.actors.get('a')!,
      b = w.actors.get('b')!
    a.position = [-2, 0]
    b.position = [2, 0]
    a.path = [[2, 0]]
    b.path = [[-2, 0]]
    a.phase = b.phase = 'return'
    for (let i = 0; i < 200; i++) {
      w.tick(0.05, true, false)
      expect(
        Math.hypot(
          a.position[0] - b.position[0],
          a.position[1] - b.position[1],
        ),
      ).toBeGreaterThanOrEqual(0.58)
    }
    expect(a.phase).toBe('dwell')
    expect(b.phase).toBe('dwell')
  })
  it('returns around a stationary occupant instead of waiting forever', () => {
    const w = new ActivityWorld(plan)
    w.reconcile([
      { key: 'returning', home: [3, 0], intent: 'work' },
      { key: 'seated', home: [0, 0], intent: 'work' },
    ])
    const actor = w.actors.get('returning')!
    actor.position = [-3, 0]
    actor.path = [[3, 0]]
    actor.phase = 'return'
    advance(w, 8)
    expect(actor.position).toEqual([3, 0])
    expect(actor.phase).toBe('dwell')
    expect(w.actors.get('seated')!.position).toEqual([0, 0])
  })
  it('escapes the clearance margin of a stationary blocker', () => {
    const w = new ActivityWorld(plan)
    w.reconcile([
      { key: 'mover', home: [3, 0], intent: 'work' },
      { key: 'seated', home: [0.61, 0], intent: 'work' },
    ])
    const actor = w.actors.get('mover')!
    actor.position = [0, 0]
    actor.path = [[3, 0]]
    actor.phase = 'return'
    advance(w, 8)
    expect(actor.position).toEqual([3, 0])
    expect(actor.phase).toBe('dwell')
  })
  it('passes on the other side when the first side is a wall', () => {
    const w = new ActivityWorld({
      ...plan,
      obstacles: [{ x: 0, z: -0.49, halfX: 2, halfZ: 0.2 }],
    })
    w.reconcile([
      { key: 'a', home: [2, 0], intent: 'work' },
      { key: 'b', home: [-2, 0], intent: 'work' },
    ])
    const a = w.actors.get('a')!,
      b = w.actors.get('b')!
    a.position = [-2, 0]
    b.position = [2, 0]
    a.path = [[2, 0]]
    b.path = [[-2, 0]]
    a.phase = b.phase = 'return'
    advance(w, 10)
    expect(a.phase).toBe('dwell')
    expect(b.phase).toBe('dwell')
  })
  it('replans when new furniture appears in a previously clear path', () => {
    const w = new ActivityWorld(plan)
    w.reconcile([{ key: 'a', home: [3, 0], intent: 'work' }])
    const a = w.actors.get('a')!
    a.position = [-3, 0]
    a.path = [[3, 0]]
    a.phase = 'return'
    const updated = {
      ...plan,
      obstacles: [{ x: 0, z: 0, halfX: 0.8, halfZ: 0.8 }],
    }
    w.reconcile([{ key: 'a', home: [3, 0], intent: 'work' }], updated)
    for (let i = 0; i < 200; i++) {
      w.tick(0.05, true, false)
      expect(walkable(a.position, updated)).toBe(true)
    }
    expect(a.phase).toBe('dwell')
  })
  it('passes without rejecting distant occupants on both sides', () => {
    const w = new ActivityWorld(plan)
    w.reconcile([
      { key: 'a', home: [2, 0], intent: 'work' },
      { key: 'b', home: [-2, 0], intent: 'work' },
      { key: 'far1', home: [0, 5], intent: 'work' },
      { key: 'far2', home: [0, -5], intent: 'work' },
    ])
    const a = w.actors.get('a')!,
      b = w.actors.get('b')!
    a.position = [-2, 0]
    b.position = [2, 0]
    a.path = [[2, 0]]
    b.path = [[-2, 0]]
    a.phase = b.phase = 'return'
    advance(w, 10)
    expect(a.phase).toBe('dwell')
    expect(b.phase).toBe('dwell')
  })
  it('escapes furniture spawned around its current transit point', () => {
    const w = new ActivityWorld(plan)
    w.reconcile([{ key: 'a', home: [3, 0], intent: 'work' }])
    const a = w.actors.get('a')!
    a.position = [0, 0]
    a.path = [[3, 0]]
    a.phase = 'return'
    w.reconcile([{ key: 'a', home: [3, 0], intent: 'work' }], {
      ...plan,
      obstacles: [{ x: 0, z: 0, halfX: 0.8, halfZ: 0.8 }],
    })
    advance(w, 10)
    expect(a.phase).toBe('dwell')
    expect(a.position).toEqual([3, 0])
  })
  it.each([false, true])(
    'returns twenty actors after crowded idle traffic, server=%s',
    (server) => {
      const layout = officeLayout(
        Array.from({ length: 20 }, (_, i) =>
          member({ id: `m${i}`, projectId: 'p' }),
        ),
      )
      const p = floorPlan(
        layout,
        -9,
        Math.max(8, ...layout.map((d) => d.x + 2)),
        -7,
        Math.max(5, ...layout.map((d) => d.z + 3)),
        server,
      )
      const w = new ActivityWorld(p)
      const members = layout.map((d) => ({
        key: d.id,
        home: [d.x, d.z + 0.38] as [number, number],
        intent: 'idle' as Intent,
      }))
      w.reconcile(members)
      advance(w, 120)
      w.reconcile(members.map((m) => ({ ...m, intent: 'work' as Intent })))
      advance(w, 120)
      for (const actor of w.actors.values()) {
        expect(actor.phase).toBe('dwell')
        expect(actor.position).toEqual(actor.home)
      }
      expect(w.reservations.size).toBe(0)
    },
  )
  it('detects even a short furniture corner intersection', () => {
    const layout = officeLayout(
      Array.from({ length: 5 }, (_, i) =>
        member({ id: `m${i}`, projectId: 'p' }),
      ),
    )
    const p = floorPlan(layout, -9, 8, -7, 5, false)
    const start: [number, number] = [-2.1111897750915594, 10.847202556227108]
    expect(clearSegment(start, [-3.5, 10.5], p)).toBe(false)
    for (const point of findPath(start, [-6, -3.62], p))
      expect(walkable(point, p)).toBe(true)
  })
  it('treats child tables and lounge side tables as furniture', () => {
    const p = floorPlan([], -9, 8, -7, 5, false, [[0, 0]])
    expect(walkable([0, -0.2], p)).toBe(false)
    const book = p.slots.find((s) => s.activity === 'book')!
    expect(walkable([book.point[0] + 0.55, book.point[1] - 0.8], p)).toBe(false)
    expect(findPath([-2, -1], [2, -1], p).length).toBeGreaterThan(0)
  })
  it('does not teleport relaxing actors when a child workstation appears', () => {
    const p = floorPlan([], -9, 8, -7, 5, false)
    const w = new ActivityWorld(p)
    w.reconcile([{ key: 'parent', home: [-2, -2], intent: 'idle' }])
    const actor = w.actors.get('parent')!
    actor.position = [2, 2]
    actor.phase = 'perform'
    actor.activity = 'book'
    actor.interaction = 1
    w.reconcile(
      [{ key: 'parent', home: [-2, -2], intent: 'work' }],
      floorPlan([], -9, 8, -7, 5, false, [[0, 0]]),
    )
    expect(actor.position).toEqual([2, 2])
    expect(actor.phase).toBe('cleanup')
  })
  it('focuses current positions, including children and the DevOps height', () => {
    const floors = [world(), world()]
    floors[0].reconcile([])
    floors[1].reconcile([
      { key: 'parent', home: [1, 2], intent: 'idle' },
      { key: 'child-key', home: [2, 3], intent: 'work' },
    ])
    floors[1].actors.get('parent')!.position = [4, 5]
    expect(actualSelection(floors, 'parent')).toEqual([4, 5, 5])
    expect(actualSelection(floors, 'parent', 'child-key')).toEqual([2, 5, 3])
    expect(actualSelection(floors, 'absent')).toBeUndefined()
  })
})

it('invalidates cached navigation when furniture changes in the same plan object', () => {
  const dynamic: FloorPlan = {
    minX: -5,
    maxX: 5,
    minZ: -5,
    maxZ: 5,
    slots: [],
    obstacles: [{ x: 0, z: 0, halfX: 1, halfZ: 1 }],
  }
  findPath([-3, 0], [3, 0], dynamic)
  dynamic.obstacles.push({ x: 0, z: -2, halfX: 1.2, halfZ: 1.2 })
  const path = findPath([-3, 0], [3, 0], dynamic)
  expect(path.length).toBeGreaterThan(0)
  let previous: [number, number] = [-3, 0]
  for (const point of path) {
    expect(clearSegment(previous, point, dynamic)).toBe(true)
    previous = point
  }
})
