import { describe, expect, it } from 'vitest'
import { buildTimeline, collapseWorkLog, formatTurnStamp, turnBoundaries } from '@/features/agent-chat/timeline'
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

describe('collapseWorkLog', () => {
  it('shows exactly one visible entry and reports N-1 hidden, for N tool entries', () => {
    const items = [item('tool', 'i1'), item('tool', 'i2'), item('tool', 'i3'), item('tool', 'i4')]
    const { visible, hidden } = collapseWorkLog(items)
    expect(visible).toHaveLength(1)
    expect(hidden).toHaveLength(3)
  })

  it('shows the newest entry as the visible one', () => {
    const items = [item('tool', 'i1'), item('tool', 'i2'), item('tool', 'i3')]
    const { visible, hidden } = collapseWorkLog(items)
    expect(visible.map((i) => i.id)).toEqual(['i3'])
    expect(hidden.map((i) => i.id)).toEqual(['i1', 'i2'])
  })

  it('has no disclosure with a single entry', () => {
    const items = [item('tool', 'i1')]
    const { visible, hidden } = collapseWorkLog(items)
    expect(visible).toHaveLength(1)
    expect(hidden).toHaveLength(0)
  })

  it('respects a custom maxVisible', () => {
    const items = [item('tool', 'i1'), item('tool', 'i2'), item('tool', 'i3')]
    const { visible, hidden } = collapseWorkLog(items, 2)
    expect(visible.map((i) => i.id)).toEqual(['i2', 'i3'])
    expect(hidden.map((i) => i.id)).toEqual(['i1'])
  })
})

describe('turnBoundaries', () => {
  it('groups entries into one turn per leading user message', () => {
    const view = viewWith([
      item('user', 'u1', 'hi'),
      item('assistant', 'a1', 'hello'),
      item('user', 'u2', 'again'),
      item('tool', 't1'),
      item('assistant', 'a2', 'done'),
    ])
    const entries = buildTimeline(view)
    const turns = turnBoundaries(entries)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ key: 'u1', lastEntryIndex: 1 })
    expect(turns[1]).toMatchObject({ key: 'u2', lastEntryIndex: 4 })
  })

  it('gives entries with no leading user message their own turn', () => {
    const view = viewWith([item('assistant', 'a1', 'hello')])
    const entries = buildTimeline(view)
    const turns = turnBoundaries(entries)
    expect(turns).toHaveLength(1)
    expect(turns[0].lastEntryIndex).toBe(0)
  })
})

describe('formatTurnStamp', () => {
  it('formats a wall-clock time and a rounded-second duration', () => {
    const startedAt = new Date('2026-01-01T14:40:02.000Z').getTime()
    const completedAt = startedAt + 10_000
    const stamp = formatTurnStamp(startedAt, completedAt)
    expect(stamp).toContain('10s')
    expect(stamp).toContain('•')
  })

  it('never reports a negative duration', () => {
    const stamp = formatTurnStamp(2000, 1000)
    expect(stamp).toContain('0s')
  })
})
