import Html from '@/features/agent-workspace/OfficeHtml'
import { Block, cylinder } from '@/features/agent-workspace/officePrimitives'
import { deskShape } from '@/features/agent-workspace/furniture'
import { statusColor } from '@/features/agent-workspace/model'
import type { OfficeMember } from '@/features/agent-workspace/model'
import {
  characterProfile,
  workPresentation,
  visualStatus,
} from '@/features/agent-workspace/presentation'
export function Plant({
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
export function Chair({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Block
        at={[0, 0.48, 0]}
        size={[0.66, 0.14, 0.64]}
        color="#424e53"
        surface="fabric"
        soft
      />
      <Block
        at={[0, 0.86, 0.29]}
        size={[0.63, 0.68, 0.13]}
        color="#45555a"
        surface="fabric"
        soft
      />
      <Block at={[0, 0.22, 0]} size={[0.08, 0.4, 0.08]} color="#333e40" />
      <Block at={[0, 0.07, 0]} size={[0.62, 0.07, 0.12]} color="#333e40" />
      <Block at={[0, 0.07, 0]} size={[0.12, 0.07, 0.6]} color="#333e40" />
    </group>
  )
}
export function Desk({
  x,
  z,
  member,
  onSelect,
  night = false,
  compact = false,
}: {
  night?: boolean
  compact?: boolean
  x: number
  z: number
  member?: OfficeMember
  onSelect: (member: OfficeMember, child?: string) => void
}) {
  const profile = characterProfile(member?.key || `${x}:${z}`)
  const work = member ? workPresentation(member) : undefined
  const status = member ? visualStatus(member) : 'idle'
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
        <Block
          at={[0, 0.9, deskShape.centerZ]}
          size={[deskShape.width, 0.13, deskShape.depth]}
          color="#c8ac85"
          surface="wood"
          soft
          shadow
        />
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
              surface="screen"
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
        <Chair x={0} z={deskShape.seatZ} />
        {profile.desk === 1 && (
          <Block
            at={[-0.7, 1.02, -0.3]}
            size={[0.3, 0.08, 0.22]}
            color={profile.shirt}
            surface="fabric"
            soft
          />
        )}
        {profile.desk === 2 && (
          <group position={[-0.72, 1.12, -0.5]}>
            <Block
              at={[0, -0.08, 0]}
              size={[0.13, 0.16, 0.13]}
              color="#b7a58d"
            />
            <Block
              at={[0, 0.08, 0]}
              size={[0.18, 0.2, 0.18]}
              color="#779776"
              round
            />
          </group>
        )}
        <Block
          at={[0.8, 1.15, -0.55]}
          size={[0.04, 0.4, 0.04]}
          color="#5d6a70"
          surface="metal"
        />
        <Block
          at={[0.7, 1.36, -0.55]}
          size={[0.3, 0.06, 0.2]}
          color={night ? '#e5bb7b' : '#7f8d8c'}
          surface={night ? 'screen' : 'metal'}
          soft
        />
        {work && !compact && (
          <Html position={[0, 1.62, -0.45]} center zIndexRange={[2, 0]}>
            <span className="office-work-label" title={work.label}>
              {work.kind === 'command'
                ? '›_'
                : work.kind === 'file_change'
                  ? '✎'
                  : work.kind === 'tool'
                    ? '⚙'
                    : '·'}{' '}
              {work.kind === 'command'
                ? 'Command'
                : work.kind === 'file_change'
                  ? 'Files'
                  : work.kind === 'tool'
                    ? 'Tool'
                    : work.label}
              {work.count > 1 ? ` · ${work.count}` : ''}
            </span>
          </Html>
        )}
      </group>
    </group>
  )
}
