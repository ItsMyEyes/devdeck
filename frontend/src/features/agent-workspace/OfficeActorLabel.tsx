import { useState } from 'react'
import Html from '@/features/agent-workspace/OfficeHtml'
import {
  workPresentation,
  visualStatus,
} from '@/features/agent-workspace/presentation'
import {
  childCharacterName,
  statusColor,
  statusLabel,
} from '@/features/agent-workspace/model'
import type { OfficeMember } from '@/features/agent-workspace/model'
export default function OfficeActorLabel({
  member,
  child,
  selected,
  completed,
  onSelect,
  hovered = false,
}: {
  member: OfficeMember
  child?: string
  selected: boolean
  completed: boolean
  hovered?: boolean
  onSelect: (member: OfficeMember, child?: string) => void
}) {
  const [focused, setFocused] = useState(false)
  const [badgeHovered, setBadgeHovered] = useState(false)
  const expanded = selected || hovered || badgeHovered || focused
  const work = workPresentation(member, child)
  const sub = member.subagents.find((c) => c.id === child)
  const status = visualStatus(member, child)
  const name = child
    ? childCharacterName(member, child)
    : member.characterName || member.title || member.agent
  return (
    <Html
      position={[0, 2.1, 0]}
      center
      kind="actor"
      priority={selected ? 3 : expanded ? 2 : -1}
      zIndexRange={[10, 0]}
    >
      <button
        className={`office-label ${selected ? 'is-selected' : ''} ${expanded ? '' : 'is-dot'}`}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPointerEnter={() => setBadgeHovered(true)}
        onPointerLeave={() => setBadgeHovered(false)}
        aria-label={`${name} · ${child ? sub?.title || 'Subagent' : member.title} · ${status === 'unknown' ? 'Unverified' : child ? status : statusLabel(member)}`}
        onClick={(event) => {
          event.stopPropagation()
          onSelect(member, child)
        }}
      >
        {completed && <span className="office-result-marker">✓ Result</span>}
        <i style={{ color: statusColor(status) }} />
        <span
          className={!expanded ? 'office-child-compact-name' : undefined}
          style={{
            maxWidth: expanded ? 130 : 68,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {name}
        </span>
        {expanded && (
          <span style={{ fontSize: 8, opacity: 0.7 }}>
            {work.label}
            {work.count > 1 ? ` · ${work.count}` : ''}
          </span>
        )}
      </button>
    </Html>
  )
}
