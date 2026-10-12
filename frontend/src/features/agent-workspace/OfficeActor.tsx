import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import type { Group } from 'three'
import OfficeCharacter from '@/features/agent-workspace/OfficeCharacter'
import {
  childCharacterName,
  statusColor,
  statusLabel,
} from '@/features/agent-workspace/model'
import type { OfficeMember } from '@/features/agent-workspace/model'
import type { Actor } from '@/features/agent-workspace/activity'

export default function OfficeActor({
  actor,
  member,
  child,
  reduced,
  selected,
  compact,
  onSelect,
}: {
  actor: Actor
  member: OfficeMember
  child?: string
  reduced: boolean
  selected: boolean
  compact: boolean
  onSelect: (member: OfficeMember, child?: string) => void
}) {
  const root = useRef<Group>(null)
  const sub = member.subagents.find((c) => c.id === child)
  const status =
    member.stale || member.limited
      ? 'unknown'
      : child
        ? sub?.status || 'unknown'
        : member.status
  const name = child
    ? childCharacterName(member, child)
    : member.characterName || member.title || member.agent
  const apply = () => {
    if (!root.current) return
    root.current.position.set(actor.position[0], 0, actor.position[1])
    root.current.rotation.y = actor.yaw
    root.current.userData.activity = actor.activity || actor.intent
    root.current.userData.phase = actor.phase
  }
  useFrame(apply, -1)
  return (
    <group
      ref={(group) => {
        root.current = group
        apply()
      }}
      name={`office-actor:${actor.key}`}
      scale={child ? 0.56 : 1}
      onClick={(event) => {
        event.stopPropagation()
        onSelect(member, child)
      }}
    >
      <OfficeCharacter
        actor={actor}
        reduced={reduced}
        color={child ? '#aa8e71' : undefined}
      />
      <Html position={[0, 2.1, 0]} center zIndexRange={[10, 0]}>
        <button
          className={`office-label ${selected ? 'is-selected' : ''}`}
          aria-label={`${name} · ${child ? sub?.title || 'Subagent' : member.title} · ${status === 'unknown' ? 'Unverified' : child ? status : statusLabel(member)}`}
          onClick={(event) => {
            event.stopPropagation()
            onSelect(member, child)
          }}
        >
          <i style={{ color: statusColor(status) }} />
          <span
            style={{
              maxWidth: selected ? 110 : 68,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {compact && !selected ? name.split(/\s+/)[0] : name}
          </span>
          {selected && (
            <span style={{ fontSize: 8, opacity: 0.7 }}>
              {status === 'unknown'
                ? 'Unverified'
                : child
                  ? status
                  : statusLabel(member)}
            </span>
          )}
        </button>
      </Html>
    </group>
  )
}
