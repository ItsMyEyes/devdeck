import { useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import OfficeActorLabel from '@/features/agent-workspace/OfficeActorLabel'
import type { Group } from 'three'
import OfficeCharacter from '@/features/agent-workspace/OfficeCharacter'
import type { OfficeMember } from '@/features/agent-workspace/model'
import type { Actor } from '@/features/agent-workspace/activity'

export default function OfficeActor({
  actor,
  member,
  child,
  reduced,
  selected,
  compact,
  completed = false,
  onSelect,
}: {
  actor: Actor
  member: OfficeMember
  child?: string
  reduced: boolean
  selected: boolean
  compact: boolean
  completed?: boolean
  onSelect: (member: OfficeMember, child?: string) => void
}) {
  const root = useRef<Group>(null)
  const [hovered, setHovered] = useState(false)
  void compact
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
      onPointerOver={(event) => {
        event.stopPropagation()
        setHovered(true)
      }}
      onPointerOut={() => setHovered(false)}
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
      <OfficeActorLabel
        member={member}
        child={child}
        selected={selected}
        completed={completed}
        hovered={hovered}
        onSelect={onSelect}
      />
    </group>
  )
}
