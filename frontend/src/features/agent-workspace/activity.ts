import { avatarKey, needsAttention } from '@/features/agent-workspace/model'
import type {
  DeskPosition,
  OfficeMember,
} from '@/features/agent-workspace/model'

export type Point = [number, number]
export const activities = [
  'sofa',
  'beanbag',
  'coffee',
  'tea',
  'drink',
  'guitar',
  'book',
  'stretch',
  'plant',
] as const
export type Activity = (typeof activities)[number]
export type Intent = 'work' | 'attention' | 'error' | 'unverified' | 'idle'
export type Phase =
  'dwell' | 'approach' | 'setup' | 'perform' | 'cleanup' | 'return'
export interface Slot {
  id: string
  activity: Activity
  point: Point
  seated: boolean
  seat?: Point
}
export interface Obstacle {
  x: number
  z: number
  halfX: number
  halfZ: number
}
export interface FloorPlan {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  obstacles: Obstacle[]
  slots: Slot[]
}
export interface Actor {
  key: string
  home: Point
  position: Point
  yaw: number
  intent: Intent
  phase: Phase
  activity?: Activity
  last?: Activity
  slot?: string
  path: Point[]
  elapsed: number
  duration: number
  interaction: number
  cleanupFrom: number
  idleTime: number
  dwell: number
  random: number
  time: number
  seated: boolean
}
export function seedFor(key: string) {
  let seed = 2166136261
  for (const c of key) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619)
  return seed >>> 0 || 1
}
function random(actor: Actor) {
  actor.random = (Math.imul(actor.random, 1664525) + 1013904223) >>> 0
  return actor.random / 4294967296
}
export function actorIntent(member: OfficeMember, child?: string): Intent {
  if (member.stale || member.limited || member.archivedAt || member.archiving)
    return 'unverified'
  const sub = child && member.subagents.find((c) => c.id === child)
  if (child)
    return !sub
      ? 'unverified'
      : sub.status === 'failed'
        ? 'error'
        : sub.status === 'running'
          ? 'work'
          : 'unverified'
  if (
    member.status === 'error' ||
    member.subagents.some((c) => c.status === 'failed')
  )
    return 'error'
  if (needsAttention(member) || member.questions > 0 || member.approvals > 0)
    return 'attention'
  if (member.status === 'unknown') return 'unverified'
  if (member.turnInFlight && member.status === 'running') return 'work'
  if (
    member.status !== 'idle' ||
    member.turnInFlight ||
    member.subagents.some((c) => c.status === 'running')
  )
    return 'unverified'
  return 'idle'
}
export function makeActor(key: string, home: Point, intent: Intent): Actor {
  const actor: Actor = {
    key,
    home: [...home],
    position: [...home],
    yaw: 0,
    intent,
    phase: 'dwell',
    path: [],
    elapsed: 0,
    duration: 0,
    interaction: 0,
    cleanupFrom: 0,
    idleTime: 0,
    dwell: 0,
    random: seedFor(key),
    time: 0,
    seated: true,
  }
  actor.dwell = 8 + random(actor) * 7
  return actor
}
export function companionHome(desk: DeskPosition, index: number): Point {
  return [
    desk.x + 0.65 + (index % 2) * 0.65,
    desk.z + 1.65 + Math.floor(index / 2) * 0.7,
  ]
}
export function actorId(member: OfficeMember, child?: string) {
  return child ? avatarKey(member.sourceId, member.id, child) : member.key
}
export function floorPlan(
  desks: DeskPosition[],
  minX: number,
  maxX: number,
  minZ: number,
  deskMaxZ: number,
  server: boolean,
  companions: Point[] = [],
): FloorPlan {
  const slots: Slot[] = activities.map((activity, index) => ({
    id: activity,
    activity,
    point: [
      minX + 3 + (index % 3) * 4.5,
      deskMaxZ + 6 + Math.floor(index / 3) * 2.6,
    ],
    seated: ['sofa', 'beanbag', 'guitar', 'book', 'drink'].includes(activity),
  }))
  for (const slot of slots)
    if (slot.seated) slot.seat = [slot.point[0], slot.point[1] - 0.45]
  const obstacles: Obstacle[] = desks.map((d) => ({
    x: d.x,
    z: d.z - 0.35,
    halfX: 1.16,
    halfZ: 0.65,
  }))
  obstacles.push(
    ...companions.flatMap(([x, z]) => [
      { x, z: z - 0.2, halfX: 0.42, halfZ: 0.25 },
      { x, z: z + 0.16, halfX: 0.3, halfZ: 0.12 },
    ]),
  )
  obstacles.push(
    ...desks.map((d) => ({ x: d.x, z: d.z + 0.78, halfX: 0.43, halfZ: 0.15 })),
  )
  obstacles.push(
    { x: minX + 0.7, z: 1, halfX: 0.65, halfZ: 1.2 },
    { x: maxX - 0.4, z: -1, halfX: 0.5, halfZ: 1.4 },
    { x: 1.5, z: deskMaxZ - 0.3, halfX: 2.8, halfZ: 0.3 },
    { x: minX + 0.6, z: deskMaxZ - 1.6, halfX: 0.8, halfZ: 1.5 },
    {
      x: minX + 3.4,
      z: deskMaxZ + 1.6,
      halfX: server ? 2.15 : 1.8,
      halfZ: 0.95,
    },
    { x: (minX + maxX) / 2 + 2, z: deskMaxZ + 1.4, halfX: 2.5, halfZ: 1.15 },
    { x: 5.5, z: deskMaxZ + 1.5, halfX: 0.45, halfZ: 1.2 },
    ...(server ? [{ x: 6.7, z: deskMaxZ + 2.8, halfX: 1.25, halfZ: 0.5 }] : []),
  )
  for (const slot of slots) {
    if (slot.activity !== 'stretch')
      obstacles.push({
        x: slot.point[0],
        z: slot.point[1] - 0.85,
        halfX: slot.activity === 'sofa' ? 1.7 : 0.85,
        halfZ: 0.65,
      })
    if (['guitar', 'book', 'drink'].includes(slot.activity))
      obstacles.push({
        x: slot.point[0] + 0.55,
        z: slot.point[1] - 0.8,
        halfX: 0.55,
        halfZ: 0.55,
      })
  }
  return {
    minX: minX + 0.5,
    maxX: maxX + 0.5,
    minZ: minZ + 0.5,
    maxZ: deskMaxZ + 12.5,
    obstacles,
    slots,
  }
}
export function walkable(point: Point, plan: FloorPlan) {
  const [x, z] = point
  return (
    x >= plan.minX &&
    x <= plan.maxX &&
    z >= plan.minZ &&
    z <= plan.maxZ &&
    !plan.obstacles.some(
      (o) => Math.abs(x - o.x) < o.halfX && Math.abs(z - o.z) < o.halfZ,
    )
  )
}
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])
export function clearSegment(a: Point, b: Point, plan: FloorPlan) {
  if (!walkable(a, plan) || !walkable(b, plan)) return false
  return !plan.obstacles.some((o) => {
    let enter = 0,
      exit = 1
    for (const axis of [0, 1] as const) {
      const center = axis === 0 ? o.x : o.z,
        half = (axis === 0 ? o.halfX : o.halfZ) - 1e-7
      const delta = b[axis] - a[axis]
      if (Math.abs(delta) < 1e-10) {
        if (Math.abs(a[axis] - center) >= half) return false
        continue
      }
      const first = (center - half - a[axis]) / delta,
        last = (center + half - a[axis]) / delta
      enter = Math.max(enter, Math.min(first, last))
      exit = Math.min(exit, Math.max(first, last))
      if (enter >= exit) return false
    }
    return enter < exit
  })
}
// Half-unit aisle grid is derived from furniture; routes never teleport across a desk.
export function findPath(start: Point, end: Point, plan: FloorPlan): Point[] {
  if (clearSegment(start, end, plan)) return [[...end]]
  const nodes: Point[] = []
  const indices = new Map<string, number>()
  for (let x = Math.ceil(plan.minX * 2); x <= plan.maxX * 2; x++)
    for (let z = Math.ceil(plan.minZ * 2); z <= plan.maxZ * 2; z++) {
      const point: Point = [x / 2, z / 2]
      if (walkable(point, plan)) {
        indices.set(`${x},${z}`, nodes.length)
        nodes.push(point)
      }
    }
  const nearest = (point: Point) =>
    nodes
      .map((p, i) => ({ i, d: distance(point, p) }))
      .sort((a, b) => a.d - b.d)
      .find(({ i }) => clearSegment(point, nodes[i], plan))?.i
  const first = nearest(start),
    last = nearest(end)
  if (first === undefined || last === undefined) return []
  const queue = [first],
    previous = new Map<number, number>([[first, -1]])
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]
    if (i === last) break
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const next = indices.get(
        `${nodes[i][0] * 2 + dx},${nodes[i][1] * 2 + dz}`,
      )
      if (
        next !== undefined &&
        !previous.has(next) &&
        clearSegment(nodes[i], nodes[next], plan)
      ) {
        previous.set(next, i)
        queue.push(next)
      }
    }
  }
  if (!previous.has(last)) return []
  const route: Point[] = [[...end]]
  for (let i = last; i !== -1; i = previous.get(i)!) route.unshift(nodes[i])
  // Collapse visible waypoints without cutting corners through furniture.
  const result: Point[] = []
  let at = start
  for (let i = 0; i < route.length;) {
    let far = i
    while (far + 1 < route.length && clearSegment(at, route[far + 1], plan))
      far++
    result.push(route[far])
    at = route[far]
    i = far + 1
  }
  return result
}
export class ActivityWorld {
  actors = new Map<string, Actor>()
  reservations = new Map<string, string>()
  plan: FloorPlan
  private diagnostic?: (event: string, key: string, detail: string) => void
  constructor(
    plan: FloorPlan,
    diagnostic?: (event: string, key: string, detail: string) => void,
  ) {
    this.plan = plan
    this.diagnostic = diagnostic
  }
  reconcile(
    members: { key: string; home: Point; intent: Intent }[],
    plan: FloorPlan = this.plan,
  ) {
    const obstaclesChanged =
      JSON.stringify(plan.obstacles) !== JSON.stringify(this.plan.obstacles)
    const layoutChanged =
      JSON.stringify([
        plan.minX,
        plan.maxX,
        plan.minZ,
        plan.maxZ,
        plan.slots,
      ]) !==
      JSON.stringify([
        this.plan.minX,
        this.plan.maxX,
        this.plan.minZ,
        this.plan.maxZ,
        this.plan.slots,
      ])
    this.plan = plan
    const keys = new Set(members.map((m) => m.key))
    for (const [key, actor] of this.actors)
      if (!keys.has(key)) {
        this.release(actor)
        this.actors.delete(key)
      }
    for (const member of members) {
      let actor = this.actors.get(member.key)
      if (!actor) {
        actor = makeActor(member.key, member.home, member.intent)
        this.actors.set(member.key, actor)
      }
      if (layoutChanged || distance(actor.home, member.home) > 0.01) {
        this.release(actor)
        // A different floor/group changes the local coordinate system; reset transient activity.
        Object.assign(actor, makeActor(member.key, member.home, member.intent))
      }
      if (obstaclesChanged && ['approach', 'return'].includes(actor.phase)) {
        const goal =
          actor.phase === 'return'
            ? actor.home
            : plan.slots.find((s) => s.id === actor.slot)?.point
        if (goal) {
          if (walkable(actor.position, plan))
            actor.path = findPath(actor.position, goal, plan)
          else {
            const [x, z] = actor.position
            const containing = plan.obstacles.filter(
              (o) => Math.abs(x - o.x) < o.halfX && Math.abs(z - o.z) < o.halfZ,
            )
            const escapePlan = {
              ...plan,
              obstacles: plan.obstacles.filter((o) => !containing.includes(o)),
            }
            const exits: Point[] = containing.flatMap(
              (o) =>
                [
                  [o.x - o.halfX - 0.05, z],
                  [o.x + o.halfX + 0.05, z],
                  [x, o.z - o.halfZ - 0.05],
                  [x, o.z + o.halfZ + 0.05],
                ] as Point[],
            )
            const exit = exits
              .sort(
                (a, b) =>
                  distance(actor.position, a) - distance(actor.position, b),
              )
              .find(
                (p) =>
                  walkable(p, plan) &&
                  clearSegment(actor.position, p, escapePlan),
              )
            if (exit) actor.path = [exit, ...findPath(exit, goal, plan)]
          }
        }
      }
      actor.intent = member.intent
      if (member.intent !== 'idle') actor.idleTime = 0
      if (
        member.intent !== 'idle' &&
        !['dwell', 'return', 'cleanup'].includes(actor.phase)
      )
        this.phase(actor, 'cleanup')
    }
  }
  private phase(actor: Actor, phase: Phase) {
    if (phase === 'cleanup') actor.cleanupFrom = actor.interaction
    actor.phase = phase
    actor.elapsed = 0
    this.diagnostic?.('transition', actor.key, phase)
  }
  private release(actor: Actor) {
    if (actor.slot) {
      this.reservations.delete(actor.slot)
      this.diagnostic?.('release', actor.key, actor.slot)
      actor.slot = undefined
    }
  }
  private returnHome(actor: Actor) {
    this.release(actor)
    actor.path = findPath(actor.position, actor.home, this.plan)
    this.phase(actor, 'return')
    actor.seated = false
    this.diagnostic?.('path', actor.key, `${actor.path.length} waypoints home`)
  }
  resetMotion() {
    for (const actor of this.actors.values()) {
      this.release(actor)
      actor.position = [...actor.home]
      actor.phase = 'dwell'
      actor.activity = undefined
      actor.path = []
      actor.interaction = 0
      actor.seated = true
      actor.yaw = 0
      actor.time = 0
      actor.idleTime = 0
    }
  }
  tick(delta: number, visible: boolean, reduced: boolean) {
    if (!visible || reduced) return
    const dt = Math.min(Math.max(0, delta), 0.1)
    const moving = [...this.actors.values()].sort(
      (a, b) =>
        Number(b.phase === 'return') - Number(a.phase === 'return') ||
        a.key.localeCompare(b.key),
    )
    for (const actor of moving) {
      actor.time += dt
      actor.elapsed += dt
      if (actor.phase === 'dwell') {
        actor.seated = true
        if (actor.intent !== 'idle') continue
        actor.idleTime += dt
        if (actor.idleTime < actor.dwell) continue
        const available = this.plan.slots.filter(
          (s) => s.activity !== actor.last && !this.reservations.has(s.id),
        )
        const offset = Math.floor(random(actor) * available.length)
        let slot: Slot | undefined,
          path: Point[] = []
        for (let i = 0; i < available.length; i++) {
          const candidate = available[(offset + i) % available.length]
          path = findPath(actor.position, candidate.point, this.plan)
          if (path.length) {
            slot = candidate
            break
          }
        }
        actor.duration = 20 + random(actor) * 40
        actor.idleTime = 0
        if (slot) {
          actor.slot = slot.id
          actor.activity = slot.activity
          actor.path = path
          actor.seated = false
          this.reservations.set(slot.id, actor.key)
          this.diagnostic?.('reserve', actor.key, slot.id)
          this.diagnostic?.(
            'path',
            actor.key,
            `${path.length} waypoints to ${slot.id}`,
          )
          this.phase(actor, 'approach')
        } else {
          actor.activity = actor.last === 'book' ? 'stretch' : 'book'
          this.diagnostic?.(
            'fallback',
            actor.key,
            available.length
              ? 'No reachable lounge destination'
              : 'Lounge destinations reserved',
          )
          this.phase(actor, 'setup')
        }
      } else if (actor.phase === 'approach' || actor.phase === 'return') {
        actor.seated = false
        const target = actor.path[0]
        if (!target) {
          const goal =
            actor.phase === 'return'
              ? actor.home
              : this.plan.slots.find((s) => s.id === actor.slot)?.point
          if (goal && distance(actor.position, goal) > 0.05) {
            actor.path = findPath(actor.position, goal, this.plan)
            continue
          }
          actor.yaw =
            actor.phase === 'approach' &&
            ['sofa', 'beanbag'].includes(actor.activity || '')
              ? Math.PI
              : 0
          if (actor.phase === 'return') {
            actor.activity = undefined
            actor.idleTime = 0
            actor.dwell = 8 + random(actor) * 7
            this.phase(actor, 'dwell')
          } else this.phase(actor, 'setup')
          continue
        }
        const d = distance(actor.position, target),
          step = Math.min(d, dt * (actor.phase === 'return' ? 4.2 : 1.65))
        const next: Point =
          d > 0
            ? [
                actor.position[0] +
                  ((target[0] - actor.position[0]) * step) / d,
                actor.position[1] +
                  ((target[1] - actor.position[1]) * step) / d,
              ]
            : target
        const blocker = moving.find(
          (other) =>
            other !== actor &&
            distance(next, other.position) < 0.58 &&
            distance(next, other.position) <
              distance(actor.position, other.position),
        )
        // A newly spawned companion may overlap a transit point; allow the checked escape waypoint.
        const stepPlan = walkable(actor.position, this.plan)
          ? this.plan
          : {
              ...this.plan,
              obstacles: this.plan.obstacles.filter(
                (o) =>
                  Math.abs(actor.position[0] - o.x) >= o.halfX ||
                  Math.abs(actor.position[1] - o.z) >= o.halfZ,
              ),
            }
        if (!clearSegment(actor.position, next, stepPlan)) {
          const goal =
            actor.phase === 'return'
              ? actor.home
              : this.plan.slots.find((s) => s.id === actor.slot)!.point
          actor.path = findPath(actor.position, goal, this.plan)
          continue
        }
        if (blocker) {
          const goal =
            actor.phase === 'return'
              ? actor.home
              : this.plan.slots.find((s) => s.id === actor.slot)!.point
          const stationary = !['approach', 'return'].includes(blocker.phase)
          const occupied = moving
            .filter(
              (other) =>
                other !== actor &&
                !['approach', 'return'].includes(other.phase),
            )
            .map((other) => ({
              x: other.position[0],
              z: other.position[1],
              halfX: 0.62,
              halfZ: 0.62,
            }))
          const trafficPlan = {
            ...this.plan,
            obstacles: [...this.plan.obstacles, ...occupied],
          }
          if (stationary) {
            const route = findPath(actor.position, goal, trafficPlan)
            if (route.length) {
              actor.path = route
              continue
            }
          }
          if (stationary || moving.indexOf(blocker) < moving.indexOf(actor)) {
            // Keep a passing waypoint until reached; try both sides of a narrow aisle.
            const dx = target[0] - actor.position[0],
              dz = target[1] - actor.position[1]
            const passingPlan = {
              ...this.plan,
              obstacles: [
                ...this.plan.obstacles,
                ...moving
                  .filter((other) => other !== actor)
                  .map((other) => ({
                    x: other.position[0],
                    z: other.position[1],
                    halfX: 0.62,
                    halfZ: 0.62,
                  })),
              ],
            }
            const exits: Point[] = [
              [
                actor.position[0] - dz / (d || 1),
                actor.position[1] + dx / (d || 1),
              ],
              [
                actor.position[0] + dz / (d || 1),
                actor.position[1] - dx / (d || 1),
              ],
              [
                actor.position[0] - (dx / (d || 1)) * 1.5,
                actor.position[1] - (dz / (d || 1)) * 1.5,
              ],
            ]
            for (const side of exits) {
              if (!clearSegment(actor.position, side, this.plan)) continue
              const safe = moving.every(
                (other) =>
                  other === actor ||
                  (distance(side, other.position) >= 0.58 &&
                    (distance(actor.position, other.position) >= 0.58 ||
                      distance(actor.position, other.position) <=
                        distance(side, other.position))),
              )
              if (!safe) continue
              const route = findPath(side, goal, passingPlan)
              if (route.length) {
                actor.path = [side, ...route]
                break
              }
            }
          }
          continue
        }
        actor.yaw = Math.atan2(
          -(target[0] - actor.position[0]),
          -(target[1] - actor.position[1]),
        )
        actor.position = next
        if (d <= step + 0.001) actor.path.shift()
      } else if (actor.phase === 'setup') {
        actor.interaction = Math.min(1, actor.elapsed / 1.4)
        const slot = this.plan.slots.find((s) => s.id === actor.slot)
        if (slot?.seat)
          actor.position = [
            slot.point[0],
            slot.point[1] + (slot.seat[1] - slot.point[1]) * actor.interaction,
          ]
        actor.seated =
          actor.activity !== 'stretch' &&
          (!actor.slot || !!slot?.seated) &&
          actor.interaction > 0.5
        if (actor.elapsed >= 1.4) this.phase(actor, 'perform')
      } else if (actor.phase === 'perform') {
        if (actor.elapsed >= actor.duration) this.phase(actor, 'cleanup')
      } else if (actor.phase === 'cleanup') {
        const duration = actor.intent === 'idle' ? 1.2 : 0.25
        actor.interaction =
          actor.cleanupFrom * Math.max(0, 1 - actor.elapsed / duration)
        const slot = this.plan.slots.find((s) => s.id === actor.slot)
        if (slot?.seat && actor.cleanupFrom > 0)
          actor.position = [
            slot.point[0],
            slot.point[1] + (slot.seat[1] - slot.point[1]) * actor.interaction,
          ]
        actor.seated =
          actor.activity !== 'stretch' &&
          (!actor.slot || !!slot?.seated) &&
          actor.interaction > 0.5
        if (actor.elapsed >= (actor.intent === 'idle' ? 1.2 : 0.25)) {
          actor.last = actor.activity
          this.returnHome(actor)
        }
      }
    }
  }
}
export function actualSelection(
  worlds: ActivityWorld[],
  key?: string,
  childKey?: string,
): [number, number, number] | undefined {
  const wanted = childKey || key
  for (let floor = 0; floor < worlds.length; floor++) {
    const actor = wanted && worlds[floor].actors.get(wanted)
    if (actor) return [actor.position[0], floor * 5, actor.position[1]]
  }
}
