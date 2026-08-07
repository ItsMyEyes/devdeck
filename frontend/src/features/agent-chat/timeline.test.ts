import { describe, expect, it } from 'vitest'
import { buildTimeline } from '@/features/agent-chat/timeline'
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'

function item(kind: ChatItem['kind'], id: string, text = ''): ChatItem {
  return { id, kind, text, lastSequence: 0 }
}

function viewWith(items: ChatItem[]): AgentThreadView {
  return { items, status: 'idle', lastSeq: items.length, hasGap: false, error: null }
}

describe('buildTimeline', () => {
  it('returns entries in item order', () => {
    const view = viewWith([item('user', 'i1', 'hi'), item('assistant', 'i2', 'hello')])
    const timeline = buildTimeline(view)
    expect(timeline).toHaveLength(2)
    expect(timeline.map((e) => (e.kind === 'message' ? e.item.id : e.kind))).toEqual(['i1', 'i2'])
  })

  it('collapses consecutive tool rows into one group', () => {
    const view = viewWith([
      item('assistant', 'i1', 'starting'),
      item('tool', 'i2', 'read file'),
      item('tool', 'i3', 'write file'),
      item('assistant', 'i4', 'done'),
    ])
    const timeline = buildTimeline(view)
    expect(timeline).toHaveLength(3)
    expect(timeline[1]).toMatchObject({
      kind: 'tool-group',
      items: [{ id: 'i2' }, { id: 'i3' }],
    })
  })

  it('marks reasoning entries collapsed by default', () => {
    const view = viewWith([item('reasoning', 'i1', 'thinking')])
    const timeline = buildTimeline(view)
    expect(timeline[0]).toMatchObject({ kind: 'reasoning', collapsed: true })
  })

  it('does not merge tool rows separated by another kind', () => {
    const view = viewWith([item('tool', 'i1'), item('assistant', 'i2'), item('tool', 'i3')])
    const timeline = buildTimeline(view)
    expect(timeline).toHaveLength(3)
    expect(timeline[0]).toMatchObject({ kind: 'tool-group', items: [{ id: 'i1' }] })
    expect(timeline[2]).toMatchObject({ kind: 'tool-group', items: [{ id: 'i3' }] })
  })
})
