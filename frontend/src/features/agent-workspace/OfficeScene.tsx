import { useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Minus,
  Move,
  Plus,
  RotateCw,
} from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { useResolvedTheme } from '@/features/theme/useTheme'
import {
  divisionOf,
  floorLabels,
  officeLayout,
  deskGroupLabel,
  statusColor,
} from '@/features/agent-workspace/model'
import type {
  DeskPosition,
  OfficeDivision,
  OfficeView,
  OfficeMember,
} from '@/features/agent-workspace/model'
import type { Project } from '@/store/types'
import OfficeCamera from '@/features/agent-workspace/OfficeCamera'
import OfficeActor from '@/features/agent-workspace/OfficeActor'
import OfficeLounge from '@/features/agent-workspace/OfficeLounge'
import {
  Block,
  box,
  cylinder,
} from '@/features/agent-workspace/officePrimitives'
import {
  ActivityWorld,
  actorId,
  actorIntent,
  actualSelection,
  companionHome,
  floorPlan,
} from '@/features/agent-workspace/activity'
import type { FloorPlan } from '@/features/agent-workspace/activity'

interface Props {
  workspaceId: string
  view: OfficeView
  onViewChange: (view: OfficeView) => void
  members: OfficeMember[]
  allMembers: OfficeMember[]
  projects: Project[]
  selectedKey?: string
  selectedChild?: string
  focusId: number
  runtimeSummary: string
  visible: boolean
  reset: number
  onSelect: (m: OfficeMember, child?: string) => void
  onModule: (module: string) => void
}
function Plant({
  x,
  z,
  large = false,
}: {
  x: number
  z: number
  large?: boolean
}) {
  return (
    <group position={[x, 0, z]} scale={large ? 1.3 : 0.7}>
      <mesh
        position={[0, 0.22, 0]}
        scale={[0.25, 0.44, 0.25]}
        geometry={cylinder}
        castShadow
      >
        <meshStandardMaterial color="#b59e88" />
      </mesh>
      <Block at={[0, 0.6, 0]} size={[0.04, 0.6, 0.04]} color="#67775b" />
      {[-1, 1].map((n) => (
        <group key={n} rotation={[0, n * 0.8, n * 0.25]}>
          <Block
            at={[n * 0.12, 0.86, 0]}
            size={[0.15, 0.34, 0.09]}
            color={n === 1 ? '#5f8267' : '#7d9873'}
            round
          />
        </group>
      ))}
    </group>
  )
}
function Chair({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Block at={[0, 0.48, 0]} size={[0.66, 0.14, 0.64]} color="#424e53" />
      <Block at={[0, 0.86, 0.29]} size={[0.63, 0.68, 0.13]} color="#45555a" />
      <Block at={[0, 0.22, 0]} size={[0.08, 0.4, 0.08]} color="#333e40" />
      <Block at={[0, 0.07, 0]} size={[0.62, 0.07, 0.12]} color="#333e40" />
      <Block at={[0, 0.07, 0]} size={[0.12, 0.07, 0.6]} color="#333e40" />
    </group>
  )
}
function Desk({
  x,
  z,
  member,
  onSelect,
}: {
  x: number
  z: number
  member?: OfficeMember
  onSelect: Props['onSelect']
}) {
  const status = member?.stale ? 'unknown' : (member?.status ?? 'idle')
  return (
    <group position={[x, 0, z]}>
      <group
        onClick={
          member
            ? (e) => {
                e.stopPropagation()
                onSelect(member)
              }
            : undefined
        }
      >
        <Block at={[0, 0.9, -0.35]} size={[2.05, 0.13, 0.92]} color="#c8ac85" />
        {[-0.85, 0.85].map((n) => (
          <Block
            key={n}
            at={[n, 0.43, -0.35]}
            size={[0.065, 0.86, 0.6]}
            color="#79847e"
          />
        ))}
        <group position={[0, 0.982, -0.15]}>
          <Block at={[0, 0, 0]} size={[0.64, 0.035, 0.42]} color="#4e5758" />
          <Block
            at={[0, 0.025, -0.03]}
            size={[0.53, 0.014, 0.21]}
            color="#29343d"
          />
          <group position={[0, 0, -0.2]} rotation={[-0.14, 0, 0]}>
            <Block
              at={[0, 0.23, 0]}
              size={[0.64, 0.46, 0.04]}
              color="#3b4548"
            />
            <Block
              at={[0, 0.23, 0.025]}
              size={[0.56, 0.38, 0.012]}
              color={member ? statusColor(status) : '#657d81'}
            />
          </group>
        </group>
        <Block
          at={[0.43, 0.982, -0.12]}
          size={[0.1, 0.035, 0.13]}
          color="#48585a"
        />
        <Block
          at={[-0.65, 0.99, -0.25]}
          size={[0.32, 0.04, 0.36]}
          color="#e7e4d8"
        />
        <mesh
          position={[0.74, 1.06, -0.44]}
          scale={[0.065, 0.16, 0.065]}
          geometry={cylinder}
        >
          <meshStandardMaterial color="#e6daca" />
        </mesh>
        <Chair x={0} z={0.38} />
      </group>
    </group>
  )
}

function OfficeFloor({
  props,
  division,
  layout,
  world,
  plan,
  reduced,
  dark,
  minX,
  minZ,
  maxX,
  width,
  depth,
  center,
}: {
  props: Props
  division: OfficeDivision
  layout: DeskPosition[]
  world: ActivityWorld
  plan: FloorPlan
  reduced: boolean
  dark: boolean
  minX: number
  minZ: number
  maxX: number
  width: number
  depth: number
  center: [number, number, number]
}) {
  const wall = dark ? '#3d4a50' : '#e3dfd3',
    floor = dark ? '#454c4b' : '#ded6c1'
  return (
    <group
      position={[0, division === 'devops' ? 5 : 0, 0]}
      onClick={(e) => {
        if (props.view === 'building' && e.delta < 4) {
          e.stopPropagation()
          props.onViewChange(division)
        }
      }}
    >
      <Block
        at={[center[0], -0.22, center[2]]}
        size={[width, 0.44, depth]}
        color={dark ? '#303d42' : '#c4c7bc'}
      />
      <Block
        at={[center[0], 0.005, center[2]]}
        size={[width - 0.12, 0.06, depth - 0.12]}
        color={floor}
      />
      {Array.from({ length: Math.ceil(depth) }, (_, i) => (
        <Block
          key={i}
          at={[center[0], 0.044, minZ - 1 + i]}
          size={[width - 0.2, 0.006, 0.025]}
          color={dark ? '#394544' : '#cec7b3'}
        />
      ))}
      <Block
        at={[center[0], 1.35, minZ]}
        size={[width, 2.7, 0.13]}
        color={wall}
      />
      <Block
        at={[minX, 1.35, center[2]]}
        size={[0.13, 2.7, depth]}
        color={wall}
      />
      {Array.from({ length: Math.floor(width / 3) }, (_, i) => (
        <group key={i} position={[minX + 1.3 + i * 3, 1.7, minZ + 0.085]}>
          <Block
            at={[0, 0, 0]}
            size={[2.2, 1.25, 0.04]}
            color={dark ? '#516c80' : '#afcbd2'}
          />
          <Block
            at={[0, 0, 0.03]}
            size={[2.25, 0.065, 0.08]}
            color={dark ? '#8a989a' : '#eef0e8'}
          />
          <Block
            at={[0, 0, 0.03]}
            size={[0.06, 1.3, 0.08]}
            color={dark ? '#8a989a' : '#eef0e8'}
          />
          <Block
            at={[0, -0.65, 0.06]}
            size={[2.4, 0.1, 0.22]}
            color="#b3b6ab"
          />
        </group>
      ))}
      {[...new Set(layout.map((d) => d.group))].map((group) => {
        const desks = layout.filter((d) => d.group === group),
          xs = desks.map((d) => d.x),
          zs = desks.map((d) => d.z)
        const x = (Math.min(...xs) + Math.max(...xs)) / 2,
          z = (Math.min(...zs) + Math.max(...zs)) / 2
        return (
          <group key={group}>
            <Block
              at={[x, 0.058, z + 0.35]}
              size={[
                Math.max(...xs) - Math.min(...xs) + 2.65,
                0.035,
                Math.max(...zs) - Math.min(...zs) + 2.9,
              ]}
              color={
                division === 'devops'
                  ? dark
                    ? '#405a6b'
                    : '#bfd0da'
                  : dark
                    ? '#3c5c5a'
                    : '#b6c9bf'
              }
            />
            <Html
              position={[x, 0.12, Math.min(...zs) - 1.25]}
              center
              zIndexRange={[1, 0]}
            >
              <span className="office-room-label">
                {division === 'devops'
                  ? deskGroupLabel(
                      props.allMembers.find((m) => m.key === desks[0].id)!,
                    )
                  : props.projects.find((p) => p.id === group)?.name ||
                    'Developer'}
              </span>
            </Html>
          </group>
        )
      })}
      {props.members
        .filter((m) => divisionOf(m) === division)
        .map((member) => {
          const desk = layout.find((d) => d.id === member.key)
          return desk ? (
            <Desk
              key={member.key}
              x={desk.x}
              z={desk.z}
              member={member}
              onSelect={props.onSelect}
            />
          ) : null
        })}
      <WorldTicker world={world} visible={props.visible} reduced={reduced} />
      {props.members
        .filter((m) => divisionOf(m) === division && !m.archivedAt)
        .map((member) => {
          const actor = world.actors.get(member.key)
          const desk = layout.find((d) => d.id === member.key)
          if (!actor || !desk) return null
          return (
            <group key={member.key}>
              <OfficeActor
                actor={actor}
                member={member}
                reduced={reduced}
                selected={
                  member.key === props.selectedKey && !props.selectedChild
                }
                compact={props.view === 'building'}
                onSelect={props.onSelect}
              />
              {member.subagents
                .filter((c) => c.status === 'running' || c.status === 'failed')
                .map((child, index) => {
                  const childActor = world.actors.get(actorId(member, child.id))
                  const [x, z] = companionHome(desk, index)
                  return childActor ? (
                    <group key={child.id}>
                      <group position={[x, 0, z]} scale={0.56}>
                        <Block
                          at={[0, 0.9, -0.35]}
                          size={[0.95, 0.08, 0.55]}
                          color="#aa8f70"
                        />
                        <Block
                          at={[0, 0.45, -0.35]}
                          size={[0.08, 0.9, 0.35]}
                          color="#526368"
                        />
                        <Block
                          at={[0, 0.96, -0.23]}
                          size={[0.6, 0.03, 0.38]}
                          color="#3b4548"
                        />
                        <Block
                          at={[0, 1.19, -0.42]}
                          size={[0.6, 0.45, 0.03]}
                          color="#637a89"
                        />
                        <Chair x={0} z={0} />
                      </group>
                      <OfficeActor
                        actor={childActor}
                        member={member}
                        child={child.id}
                        reduced={reduced}
                        selected={
                          member.key === props.selectedKey &&
                          props.selectedChild === child.id
                        }
                        compact={props.view === 'building'}
                        onSelect={props.onSelect}
                      />
                    </group>
                  ) : null
                })}
            </group>
          )
        })}
      <OfficeLounge plan={plan} dark={dark} world={world} />
      {!layout.length &&
        [
          [-5, -3],
          [-2, -3],
          [2, -3],
          [5, -3],
          [-5, 0],
          [-2, 0],
        ].map(([x, z], i) => (
          <Desk key={i} x={x} z={z} onSelect={props.onSelect} />
        ))}
      <Plant x={minX + 0.7} z={minZ + 0.7} large />
      <Plant x={maxX} z={minZ + 0.8} large />
      <Plant x={minX + 0.8} z={plan.maxZ - 12.5 + 2} large />
      <group position={[center[0] + 2, 0, plan.maxZ - 12.5 + 1.4]}>
        <Block at={[0, 0.77, 0]} size={[4.4, 0.16, 1.4]} color="#aa8f70" />
        {[-1.4, 1.4].map((n) => (
          <Block
            key={n}
            at={[n, 0.38, 0]}
            size={[0.13, 0.76, 0.8]}
            color="#526368"
          />
        ))}
        {[-1.45, 0, 1.45].map((n) => (
          <group key={n}>
            <Chair x={n} z={1} />
            <group rotation={[0, Math.PI, 0]}>
              <Chair x={n} z={1} />
            </group>
            <Block
              at={[n, 0.87, 0]}
              size={[0.5, 0.035, 0.32]}
              color="#d4cfbf"
            />
          </group>
        ))}
        <Html position={[0, 1.5, 0]} center zIndexRange={[2, 0]}>
          <span className="office-room-label">
            {division === 'developer' ? 'Discussion' : 'Incident coordination'}
          </span>
        </Html>
      </group>
      <group position={[minX + 0.7, 0, 1]}>
        <Block at={[0, 1, 0]} size={[0.8, 2, 2]} color="#ad9277" />
        {[0.4, 1, 1.6].map((y) => (
          <Block
            key={y}
            at={[0.43, y, 0]}
            size={[0.06, 0.45, 1.65]}
            color={dark ? '#51686b' : '#9caead'}
          />
        ))}
        <Html position={[0, 2.4, 0]} center zIndexRange={[3, 0]}>
          <button
            className="office-object-label"
            onClick={() =>
              props.onModule(division === 'developer' ? 'memory' : 'ssh')
            }
          >
            {division === 'developer' ? 'Memory ↗' : 'Runbooks · SSH ↗'}
          </button>
        </Html>
      </group>
      <group position={[maxX - 0.4, 0, -1]}>
        <Block at={[0, 1.1, 0]} size={[0.3, 1.6, 2.4]} color="#e2e0d2" />
        <Block at={[0, 0.32, -0.9]} size={[0.14, 0.64, 0.14]} color="#677b7d" />
        <Block at={[0, 0.32, 0.9]} size={[0.14, 0.64, 0.14]} color="#677b7d" />
        {[
          [-0.6, '#c19a72'],
          [0, '#739f95'],
          [0.6, '#8198b0'],
        ].map(([z, c]) => (
          <Block
            key={z}
            at={[-0.17, 1.35, Number(z)]}
            size={[0.025, 0.5, 0.42]}
            color={String(c)}
          />
        ))}
        <Html position={[0, 2.2, 0]} center zIndexRange={[3, 0]}>
          <button
            className="office-object-label"
            disabled={division === 'developer' && !props.projects.length}
            onClick={() =>
              props.onModule(division === 'developer' ? 'issues' : 'machines')
            }
          >
            {division === 'developer' ? 'Issues ↗' : 'Runtime status ↗'}
            {division === 'devops' && (
              <small className="office-runtime-summary">
                {props.runtimeSummary}
              </small>
            )}
          </button>
        </Html>
      </group>
      <Interior
        division={division}
        dark={dark}
        minX={minX}
        maxZ={plan.maxZ - 12.5}
        onModule={props.onModule}
      />
      <Html position={[minX + 1.5, 3, minZ]} center zIndexRange={[4, 0]}>
        <button
          className={`office-object-label is-${division}`}
          onClick={() => props.onViewChange(division)}
        >
          {floorLabels[division]} ↗
        </button>
      </Html>
    </group>
  )
}
function Glass({ x, z, width }: { x: number; z: number; width: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 1.1, 0]} scale={[width, 2.2, 0.04]} geometry={box}>
        <meshStandardMaterial
          color="#aacfd1"
          transparent
          opacity={0.16}
          depthWrite={false}
          roughness={0.2}
        />
      </mesh>
      <Block at={[0, 2.2, 0]} size={[width, 0.04, 0.06]} color="#687b7c" />
      {[-width / 2, width / 2].map((n) => (
        <Block
          key={n}
          at={[n, 1.1, 0]}
          size={[0.05, 2.2, 0.06]}
          color="#687b7c"
        />
      ))}
    </group>
  )
}
function Interior({
  division,
  dark,
  minX,
  maxZ,
  onModule,
}: {
  division: OfficeDivision
  dark: boolean
  minX: number
  maxZ: number
  onModule: (module: string) => void
}) {
  const developer = division === 'developer',
    accent = developer ? '#668b74' : '#638ba6'
  return (
    <>
      <Glass x={1.5} z={maxZ - 0.3} width={5.2} />
      <group position={[minX + 3.4, 0, maxZ + 1.6]}>
        {developer ? (
          <>
            <Block at={[0, 0.35, 0]} size={[3, 0.6, 1.2]} color={accent} />
            <Block at={[0, 0.8, -0.5]} size={[3, 0.6, 0.25]} color={accent} />
            {[-1.4, 1.4].map((x) => (
              <Block
                key={x}
                at={[x, 0.65, 0]}
                size={[0.25, 0.65, 1.2]}
                color={accent}
              />
            ))}
            <Block at={[0, 0.4, 1.2]} size={[1.5, 0.16, 0.7]} color="#bca082" />
            <Block at={[0, 0.2, 1.2]} size={[0.7, 0.4, 0.35]} color="#687b7c" />
          </>
        ) : (
          <>
            <Glass x={0} z={-0.8} width={3.8} />
            {[-1.25, 0, 1.25].map((x) => (
              <group key={x} position={[x, 0, 0]}>
                <Block at={[0, 1, 0]} size={[0.95, 2, 0.8]} color="#37484c" />
                {[0.4, 0.7, 1, 1.3, 1.6].map((y) => (
                  <Block
                    key={y}
                    at={[0, y, 0.42]}
                    size={[0.8, 0.12, 0.04]}
                    color="#637a89"
                  />
                ))}
              </group>
            ))}
            <Html position={[0, 2.4, 0]} center zIndexRange={[3, 0]}>
              <button
                className="office-object-label"
                onClick={() => onModule('machines')}
              >
                Server zone · Runtimes ↗
              </button>
            </Html>
          </>
        )}
      </group>
      <group position={[minX + 0.6, 0, maxZ - 1.6]}>
        <Block
          at={[0, 0.5, 0]}
          size={[0.9, 1, 2.4]}
          color={dark ? '#69736e' : '#c1b7a3'}
        />
        <Block at={[0, 1.05, 0]} size={[1.1, 0.1, 2.5]} color="#b89a78" />
        <Block at={[0, 1.3, -0.7]} size={[0.5, 0.5, 0.5]} color="#425254" />
        <Plant x={0} z={0.8} />
        <Html position={[0, 1.9, 0]} center zIndexRange={[2, 0]}>
          <span className="office-room-label">
            {developer ? 'Pantry' : 'Equipment'}
          </span>
        </Html>
      </group>
      <group position={[5.5, 0, maxZ + 1.5]}>
        <Block
          at={[0, 1.3, 0]}
          size={[0.12, 1.6, 1.9]}
          color={dark ? '#60716e' : '#eeeee3'}
        />
        <Block at={[0, 0.45, 0]} size={[0.14, 0.9, 0.14]} color="#677b7d" />
        <Html position={[0, 2.4, 0]} center zIndexRange={[3, 0]}>
          {developer ? (
            <button
              className="office-object-label"
              onClick={() => onModule('todos')}
            >
              Todos ↗
            </button>
          ) : (
            <button
              className="office-object-label"
              onClick={() => onModule('ssh')}
            >
              Shared SSH ↗
            </button>
          )}
        </Html>
      </group>
      {!developer && (
        <group position={[6, 0, maxZ + 2.8]}>
          <Chair x={0} z={0} />
          <Chair x={1.4} z={0} />
          <Plant x={2.2} z={0} />
        </group>
      )}
    </>
  )
}

function WorldTicker({
  world,
  visible,
  reduced,
}: {
  world: ActivityWorld
  visible: boolean
  reduced: boolean
}) {
  useFrame((_, delta) => world.tick(delta, visible, reduced), -2)
  return null
}

export default function OfficeScene(props: Props) {
  const dark = useResolvedTheme() === 'dark'
  const reduced = useReducedMotion()
  const [lost, setLost] = useState(false)
  const [action, setAction] = useState({ id: 0, type: '' })
  const [mode, setMode] = useState<'pan' | 'rotate'>('pan')
  const slots = useRef<Record<OfficeDivision, DeskPosition[]>>({
    developer: [],
    devops: [],
  })
  const layouts = useMemo(() => {
    for (const division of ['developer', 'devops'] as const) {
      slots.current[division] = officeLayout(
        props.allMembers
          .filter((m) => divisionOf(m) === division)
          .map((m) => ({ ...m, id: m.key })),
        slots.current[division],
      )
    }
    return { ...slots.current }
  }, [props.allMembers])
  const layout = [...layouts.developer, ...layouts.devops]
  const maxX = Math.max(8, ...layout.map((d) => d.x + 2))
  const deskMaxZ = Math.max(5, ...layout.map((d) => d.z + 3))
  const maxZ = deskMaxZ + 12.5
  const minX = -9,
    minZ = -7,
    width = maxX - minX + 2,
    depth = maxZ - minZ + 2
  const center: [number, number, number] = [
    (minX + maxX) / 2,
    props.view === 'devops' ? 5 : props.view === 'building' ? 2.5 : 0,
    (minZ + maxZ) / 2,
  ]
  const worlds = useRef<{ workspace: string; floors: ActivityWorld[] } | null>(
    null,
  )
  const plans = (['developer', 'devops'] as const).map((division) => {
    const companions = props.members
      .filter((m) => !m.archivedAt && divisionOf(m) === division)
      .flatMap((member) => {
        const desk = layouts[division].find((d) => d.id === member.key)
        return desk
          ? member.subagents
              .filter((c) => c.status === 'running' || c.status === 'failed')
              .map((_, i) => companionHome(desk, i))
          : []
      })
    return floorPlan(
      layouts[division],
      minX,
      maxX,
      minZ,
      deskMaxZ,
      division === 'devops',
      companions,
    )
  })
  if (!worlds.current || worlds.current.workspace !== props.workspaceId)
    worlds.current = {
      workspace: props.workspaceId,
      floors: plans.map(
        (plan) =>
          new ActivityWorld(
            plan,
            import.meta.env.DEV
              ? (event, key, detail) =>
                  console.debug('[office-animation]', event, key, detail)
              : undefined,
          ),
      ),
    }
  worlds.current.floors.forEach((world, i) => {
    const division = i === 0 ? 'developer' : 'devops'
    const actors = props.members
      .filter(
        (m) =>
          !m.archivedAt &&
          divisionOf(m) === division &&
          (props.view === 'building' || props.view === division),
      )
      .flatMap((member) => {
        const desk = layouts[division].find((d) => d.id === member.key)
        if (!desk) return []
        return [
          {
            key: member.key,
            home: [desk.x, desk.z + 0.38] as [number, number],
            intent: actorIntent(member),
          },
          ...member.subagents
            .filter((c) => c.status === 'running' || c.status === 'failed')
            .map((child, index) => ({
              key: actorId(member, child.id),
              home: companionHome(desk, index),
              intent: actorIntent(member, child.id),
            })),
        ]
      })
    world.reconcile(actors, plans[i])
    if (reduced) world.resetMotion()
  })
  const selectedMember = props.members.find((m) => m.key === props.selectedKey)
  const childKey =
    selectedMember && props.selectedChild
      ? actorId(selectedMember, props.selectedChild)
      : undefined
  const selected = actualSelection(
    worlds.current.floors,
    props.selectedKey,
    childKey,
  )
  const animate = !reduced && props.visible
  const moving = props.members.some((m) => !m.archivedAt)
  if (lost)
    return (
      <div className="office-empty">
        <h2>3D rendering paused</h2>
        <p>Your sessions remain available in the list.</p>
        <button className="office-button" onClick={() => setLost(false)}>
          Try 3D again
        </button>
      </div>
    )
  return (
    <>
      <Canvas
        className="office-renderer"
        shadows="percentage"
        camera={{ position: [18, 22, 22], fov: 38 }}
        dpr={[1, 1.5]}
        frameloop={
          !props.visible ? 'never' : animate && moving ? 'always' : 'demand'
        }
        gl={{ antialias: true, powerPreference: 'low-power' }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener(
            'webglcontextlost',
            () => setLost(true),
            { once: true },
          )
        }}
        fallback={
          <div className="office-empty">
            3D is unavailable. Use the session list to continue.
          </div>
        }
      >
        <color attach="background" args={[dark ? '#192127' : '#e9eeeb']} />
        <ambientLight intensity={dark ? 1.2 : 1.8} />
        <directionalLight
          position={[2, 18, 10]}
          intensity={dark ? 2 : 3}
          castShadow
          shadow-mapSize={[1024, 1024]}
          shadow-camera-left={-25}
          shadow-camera-right={25}
          shadow-camera-top={25}
          shadow-camera-bottom={-25}
          shadow-bias={-0.001}
        />
        <OfficeCamera
          workspaceId={props.workspaceId}
          view={props.view}
          center={center}
          span={Math.max(width, depth) * 1.45}
          reset={props.reset}
          selected={selected}
          action={action}
          mode={mode}
          focusId={props.focusId}
        />
        {(['developer', 'devops'] as const)
          .filter(
            (division) => props.view === 'building' || props.view === division,
          )
          .map((division) => (
            <OfficeFloor
              key={division}
              props={props}
              division={division}
              layout={layouts[division]}
              world={worlds.current!.floors[division === 'developer' ? 0 : 1]}
              plan={plans[division === 'developer' ? 0 : 1]}
              reduced={!!reduced}
              dark={dark}
              minX={minX}
              minZ={minZ}
              maxX={maxX}
              width={width}
              depth={depth}
              center={[center[0], 0, center[2]]}
            />
          ))}
        {props.view === 'building' && (
          <group position={[maxX - 0.1, 0, deskMaxZ - 2]}>
            {Array.from({ length: 16 }, (_, i) => (
              <Block
                key={i}
                at={[0, ((i + 1) * 5) / 16 / 2, i * 0.23]}
                size={[1.3, ((i + 1) * 5) / 16, 0.24]}
                color={dark ? '#7e8884' : '#c6b89f'}
              />
            ))}
          </group>
        )}
      </Canvas>
      <div
        className="office-camera-controls"
        role="group"
        aria-label="Camera controls"
      >
        <div
          className="office-camera-modes"
          role="group"
          aria-label="Camera drag mode"
        >
          <button
            className="office-button"
            aria-label="Move camera"
            aria-pressed={mode === 'pan'}
            onClick={() => setMode('pan')}
          >
            <Move size={14} /> Move
          </button>
          <button
            className="office-button"
            aria-label="Rotate camera"
            aria-pressed={mode === 'rotate'}
            onClick={() => setMode('rotate')}
          >
            <RotateCw size={14} /> Rotate
          </button>
        </div>
        <div className="office-camera-actions">
          {[
            { type: 'left', label: 'Move camera left', Icon: ArrowLeft },
            { type: 'up', label: 'Move camera forward', Icon: ArrowUp },
            { type: 'down', label: 'Move camera backward', Icon: ArrowDown },
            { type: 'right', label: 'Move camera right', Icon: ArrowRight },
            { type: 'in', label: 'Zoom in', Icon: Plus },
            { type: 'out', label: 'Zoom out', Icon: Minus },
            { type: 'rotate', label: 'Rotate office', Icon: RotateCw },
          ].map(({ type, label, Icon }) => (
            <button
              key={type}
              className="office-icon-button"
              aria-label={label}
              title={label}
              onClick={() => setAction((a) => ({ id: a.id + 1, type }))}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      </div>
      <div className="office-camera-hint">
        {mode === 'pan' ? 'Drag to move' : 'Drag to rotate'} · Scroll or pinch
        to zoom · Use arrow buttons to move
      </div>
    </>
  )
}
