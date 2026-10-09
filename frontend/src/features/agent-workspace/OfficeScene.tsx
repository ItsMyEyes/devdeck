import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import { BoxGeometry, CylinderGeometry, SphereGeometry, Vector3 } from 'three'
import type { Group } from 'three'
import { Minus, Plus, RotateCw } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { useResolvedTheme } from '@/features/theme/useTheme'
import {
  officeLayout,
  statusColor,
  statusLabel,
} from '@/features/agent-workspace/model'
import type {
  DeskPosition,
  OfficeMember,
} from '@/features/agent-workspace/model'
import type { Project } from '@/store/types'

const box = new BoxGeometry(1, 1, 1)
const sphere = new SphereGeometry(1, 12, 10)
const cylinder = new CylinderGeometry(1, 1, 1, 12)
const shirts = ['#548d87', '#b77858', '#717bab', '#ab8675', '#64839d']
const skins = ['#d0a583', '#a87b5f', '#ebc4a2', '#8c624b']
function hash(text: string) {
  return [...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0)
}
interface Props {
  workspaceId: string
  members: OfficeMember[]
  allMembers: OfficeMember[]
  projects: Project[]
  selectedKey?: string
  visible: boolean
  reset: number
  onSelect: (m: OfficeMember, child?: string) => void
  onModule: (module: string) => void
}
function Block({
  at,
  size,
  color,
  rotation = 0,
  round = false,
}: {
  at: [number, number, number]
  size: [number, number, number]
  color: string
  rotation?: number
  round?: boolean
}) {
  return (
    <mesh
      position={at}
      scale={size}
      rotation={[0, rotation, 0]}
      geometry={round ? sphere : box}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial color={color} roughness={0.85} />
    </mesh>
  )
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
function Person({
  seed,
  working,
  color,
}: {
  seed: string
  working: boolean
  color?: string
}) {
  const arms = useRef<Group>(null)
  const h = hash(seed)
  useFrame(({ clock }) => {
    if (arms.current && working)
      arms.current.rotation.x = Math.sin(clock.elapsedTime * 7 + h) * 0.055
  })
  const skin = skins[h % skins.length]
  return (
    <group position={[0, 0, 0.48]}>
      <Block
        at={[-0.15, 0.4, -0.08]}
        size={[0.18, 0.43, 0.2]}
        color="#354454"
      />
      <Block at={[0.15, 0.4, -0.08]} size={[0.18, 0.43, 0.2]} color="#354454" />
      <Block
        at={[-0.15, 0.17, -0.16]}
        size={[0.19, 0.13, 0.32]}
        color="#29343d"
      />
      <Block
        at={[0.15, 0.17, -0.16]}
        size={[0.19, 0.13, 0.32]}
        color="#29343d"
      />
      <Block
        at={[0, 0.9, 0.02]}
        size={[0.49, 0.65, 0.33]}
        color={color || shirts[h % shirts.length]}
      />
      <Block at={[0, 1.4, 0]} size={[0.255, 0.29, 0.23]} color={skin} round />
      <Block
        at={[0, 1.56, 0.035]}
        size={[0.27, 0.18, 0.25]}
        color="#34302e"
        round
      />
      {h % 3 === 0 && (
        <Block
          at={[0.08, 1.61, 0.15]}
          size={[0.15, 0.16, 0.15]}
          color="#34302e"
          round
        />
      )}
      <group ref={arms} position={[0, 1.04, -0.08]}>
        {[-1, 1].map((n) => (
          <group
            key={n}
            position={[n * 0.3, 0, 0]}
            rotation={[-0.4, 0, n * 0.08]}
          >
            <Block
              at={[0, -0.13, 0]}
              size={[0.15, 0.32, 0.17]}
              color={color || shirts[h % shirts.length]}
            />
            <Block
              at={[0, -0.22, -0.22]}
              size={[0.12, 0.13, 0.35]}
              color={skin}
            />
          </group>
        ))}
      </group>
      <Block
        at={[-0.085, 1.43, -0.211]}
        size={[0.028, 0.035, 0.022]}
        color="#333638"
      />
      <Block
        at={[0.085, 1.43, -0.211]}
        size={[0.028, 0.035, 0.022]}
        color="#333638"
      />
    </group>
  )
}
function Desk({
  x,
  z,
  member,
  selected,
  animate,
  onSelect,
}: {
  x: number
  z: number
  member?: OfficeMember
  selected: boolean
  animate: boolean
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
        <Block at={[0, 1.08, -0.58]} size={[0.1, 0.3, 0.08]} color="#4e5758" />
        <Block at={[0, 1.4, -0.61]} size={[0.78, 0.49, 0.06]} color="#3b4548" />
        <Block
          at={[0, 1.4, -0.573]}
          size={[0.7, 0.41, 0.012]}
          color={member ? statusColor(status) : '#657d81'}
        />
        <Block
          at={[0, 0.982, -0.16]}
          size={[0.55, 0.025, 0.18]}
          color="#5c6465"
        />
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
        <Chair x={0} z={0.67} />
        {member && (
          <Person
            seed={member.key}
            working={
              animate &&
              member.turnInFlight &&
              member.status === 'running' &&
              !member.stale
            }
          />
        )}
      </group>
      {member && (
        <Html position={[0, 2.03, 0]} center zIndexRange={[10, 0]}>
          <button
            className={`office-label ${selected ? 'is-selected' : ''}`}
            onClick={() => onSelect(member)}
            aria-label={`${member.title || member.agent} · ${statusLabel(member)}`}
          >
            <i style={{ color: statusColor(status) }} />
            <span
              style={{
                maxWidth: selected ? 110 : 58,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {member.title || member.agent || 'Agent'}
            </span>
            {selected && (
              <span style={{ fontSize: 8, opacity: 0.7 }}>
                {member.stale ? 'Unverified' : statusLabel(member)}
              </span>
            )}
          </button>
        </Html>
      )}
      {member?.subagents
        .filter((c) => c.status === 'running' || c.status === 'failed')
        .map((child, i) => (
          <group
            key={child.id}
            position={[0.65 + (i % 2) * 0.55, 0, 1.1 + Math.floor(i / 2) * 0.6]}
            scale={0.56}
            onClick={(e) => {
              e.stopPropagation()
              onSelect(member, child.id)
            }}
          >
            <Person
              seed={child.id}
              working={animate && child.status === 'running' && !member.stale}
              color="#aa8e71"
            />
            <Html position={[0, 2.1, 0]} center zIndexRange={[9, 0]}>
              <button
                className="office-label"
                onClick={() => onSelect(member, child.id)}
                style={{ fontSize: 8 }}
              >
                <i style={{ color: statusColor(child.status) }} />
                {child.role || 'Subagent'}
              </button>
            </Html>
          </group>
        ))}
    </group>
  )
}
function Camera({
  workspaceId,
  center,
  span,
  reset,
  selected,
  action,
}: {
  workspaceId: string
  center: [number, number, number]
  span: number
  reset: number
  selected?: [number, number, number]
  action: { id: number; type: string }
}) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null)
  const { camera, invalidate } = useThree()
  const defaults = useRef({ center, span })
  defaults.current = { center, span }
  useEffect(() => {
    const c = controls.current
    if (!c) return
    const { center, span } = defaults.current
    const target = new Vector3(...center)
    camera.position.set(
      target.x + span * 0.8,
      span * 0.9,
      target.z + span * 0.8,
    )
    c.target.copy(target)
    try {
      const saved = JSON.parse(
        localStorage.getItem(`devdeck.office-camera.${workspaceId}`) || 'null',
      )
      if (
        reset === 0 &&
        saved &&
        [saved.position, saved.target].every(
          (a) =>
            Array.isArray(a) &&
            a.length === 3 &&
            a.every(
              (n: unknown) =>
                typeof n === 'number' &&
                Number.isFinite(n) &&
                Math.abs(n) < 10000,
            ),
        )
      ) {
        camera.position.fromArray(saved.position)
        c.target.fromArray(saved.target)
      }
    } catch {
      /* Camera preferences are optional. */
    }
    c.update()
    invalidate()
  }, [workspaceId, reset, camera, invalidate, span, center[0], center[2]])
  useEffect(() => {
    const c = controls.current
    if (!c || !selected) return
    const next = new Vector3(...selected)
    camera.position.add(next.clone().sub(c.target))
    c.target.copy(next)
    c.update()
    invalidate()
  }, [selected?.[0], selected?.[2], camera, invalidate])
  useEffect(() => {
    const c = controls.current
    if (!c || !action.id) return
    const offset = camera.position.clone().sub(c.target)
    if (action.type === 'rotate')
      offset.applyAxisAngle(new Vector3(0, 1, 0), Math.PI / 4)
    else offset.multiplyScalar(action.type === 'in' ? 0.8 : 1.25)
    offset.clampLength(5, 100)
    camera.position.copy(c.target).add(offset)
    c.update()
    invalidate()
  }, [action, camera, invalidate])
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping={false}
      minDistance={5}
      maxDistance={100}
      minPolarAngle={0.2}
      maxPolarAngle={Math.PI / 2.25}
      onEnd={() => {
        const c = controls.current
        if (!c) return
        try {
          localStorage.setItem(
            `devdeck.office-camera.${workspaceId}`,
            JSON.stringify({
              position: camera.position.toArray(),
              target: c.target.toArray(),
            }),
          )
        } catch {
          /* Optional preference. */
        }
      }}
    />
  )
}

export default function OfficeScene(props: Props) {
  const dark = useResolvedTheme() === 'dark'
  const reduced = useReducedMotion()
  const [lost, setLost] = useState(false)
  const [action, setAction] = useState({ id: 0, type: '' })
  const slots = useRef<DeskPosition[]>([])
  const layout = useMemo(() => {
    const next = officeLayout(
      props.allMembers.map((m) => ({ ...m, id: m.key })),
      slots.current,
    )
    slots.current = next
    return next
  }, [props.allMembers])
  const maxX = Math.max(8, ...layout.map((d) => d.x + 2))
  const maxZ = Math.max(5, ...layout.map((d) => d.z + 3))
  const minX = -9,
    minZ = -7,
    width = maxX - minX + 2,
    depth = maxZ - minZ + 6
  const center: [number, number, number] = [
    (minX + maxX) / 2,
    0,
    (minZ + maxZ) / 2 + 1,
  ]
  const selected = layout.find((d) => d.id === props.selectedKey)
  const animate = !reduced && props.visible
  const working = props.members.some(
    (m) =>
      !m.stale &&
      ((m.turnInFlight && m.status === 'running') ||
        m.subagents.some((c) => c.status === 'running')),
  )
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
  const wall = dark ? '#3d4a50' : '#d8dcd1',
    floor = dark ? '#454c4b' : '#ded6c1'
  return (
    <>
      <Canvas
        shadows="percentage"
        camera={{ position: [18, 22, 22], fov: 38 }}
        dpr={[1, 1.5]}
        frameloop={
          !props.visible ? 'never' : animate && working ? 'always' : 'demand'
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
        <Camera
          workspaceId={props.workspaceId}
          center={center}
          span={Math.max(width, depth) * 1.45}
          reset={props.reset}
          selected={selected ? [selected.x, 0, selected.z] : undefined}
          action={action}
        />
        <group>
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
          {[...new Set(layout.map((d) => d.group))].map((group, i) => {
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
                    dark
                      ? ['#3c5c5a', '#59544d', '#484d65'][i % 3]
                      : ['#b6c9bf', '#cfbda4', '#bfc4d4'][i % 3]
                  }
                />
                <Html
                  position={[x, 0.12, Math.min(...zs) - 1.25]}
                  center
                  zIndexRange={[1, 0]}
                >
                  <span className="office-room-label">
                    {props.projects.find((p) => p.id === group)?.name ||
                      'Shared SSH'}
                  </span>
                </Html>
              </group>
            )
          })}
          {props.members.map((member) => {
            const desk = layout.find((d) => d.id === member.key)
            return desk ? (
              <Desk
                key={member.key}
                x={desk.x}
                z={desk.z}
                member={member}
                selected={member.key === props.selectedKey}
                animate={animate}
                onSelect={props.onSelect}
              />
            ) : null
          })}
          {!props.allMembers.length &&
            [
              [-5, -3],
              [-2, -3],
              [2, -3],
              [5, -3],
              [-5, 0],
              [-2, 0],
            ].map(([x, z], i) => (
              <Desk
                key={i}
                x={x}
                z={z}
                selected={false}
                animate={false}
                onSelect={props.onSelect}
              />
            ))}
          <Plant x={minX + 0.7} z={minZ + 0.7} large />
          <Plant x={maxX} z={minZ + 0.8} large />
          <Plant x={minX + 0.8} z={maxZ + 2} large />
          <group position={[center[0] + 2, 0, maxZ + 1.4]}>
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
              <span className="office-room-label">Team workspace</span>
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
                onClick={() => props.onModule('memory')}
              >
                Memory ↗
              </button>
            </Html>
          </group>
          <group position={[maxX - 0.4, 0, -1]}>
            <Block at={[0, 1.1, 0]} size={[0.3, 1.6, 2.4]} color="#e2e0d2" />
            <Block
              at={[0, 0.32, -0.9]}
              size={[0.14, 0.64, 0.14]}
              color="#677b7d"
            />
            <Block
              at={[0, 0.32, 0.9]}
              size={[0.14, 0.64, 0.14]}
              color="#677b7d"
            />
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
                disabled={!props.projects.length}
                onClick={() => props.onModule('issues')}
              >
                Work board ↗
              </button>
            </Html>
          </group>
          <group position={[minX + 1.3, 0, maxZ + 1.2]}>
            <Block at={[0, 0.85, 0]} size={[0.95, 1.7, 0.8]} color="#37484c" />
            {[0.4, 0.7, 1, 1.3].map((y) => (
              <Block
                key={y}
                at={[0.49, y, 0]}
                size={[0.025, 0.12, 0.58]}
                color="#84a699"
              />
            ))}
            <Html position={[0, 2.1, 0]} center zIndexRange={[3, 0]}>
              <button
                className="office-object-label"
                onClick={() => props.onModule('machines')}
              >
                Runtimes ↗
              </button>
            </Html>
          </group>
        </group>
      </Canvas>
      <div
        style={{
          position: 'absolute',
          bottom: 34,
          right: 12,
          display: 'flex',
          gap: 4,
        }}
      >
        {[
          { type: 'in', label: 'Zoom in', Icon: Plus },
          { type: 'out', label: 'Zoom out', Icon: Minus },
          { type: 'rotate', label: 'Rotate office', Icon: RotateCw },
        ].map(({ type, label, Icon }) => (
          <button
            key={type}
            className="office-icon-button"
            aria-label={label}
            onClick={() => setAction((a) => ({ id: a.id + 1, type }))}
          >
            <Icon size={14} />
          </button>
        ))}
      </div>
    </>
  )
}
