import { describe, expect, it } from 'vitest'
import { buildTimeline, collapseWorkLog, formatTokens, formatTurnEngine, formatTurnStamp, formatTurnTokens, turnBoundaries } from '@/features/agent-chat/timeline'
import { emptyThreadView } from '@/features/agent-chat/eventReducer'
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'

function item(kind: ChatItem['kind'], id: string, text = ''): ChatItem {
  return { id, kind, text, lastSequence: 0 }
}

/** Built from `emptyThreadView()` rather than a literal, so a field added to
 *  `AgentThreadView` cannot leave this fixture behind — which is exactly what
 *  happened when `pendingUserInputs` landed and only `tsc` noticed (vitest
 *  does not typecheck). */
function viewWith(items: ChatItem[]): AgentThreadView {
  return { ...emptyThreadView(), items, lastSeq: items.length }
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

  it('emits a plan entry for a plan item, not folded into a message entry', () => {
    const plan = item('plan', 'p1', '# Plan\n\n1. Do the thing')
    const view = viewWith([item('assistant', 'i1', 'here is my plan'), plan])
    const timeline = buildTimeline(view)
    expect(timeline).toHaveLength(2)
    expect(timeline[1]).toMatchObject({ kind: 'plan', item: { id: 'p1' } })
    expect(timeline[1]).not.toMatchObject({ kind: 'message' })
  })

  it('does not fold a plan entry into a surrounding tool-group', () => {
    const view = viewWith([item('tool', 'i1'), item('plan', 'p1', '# Plan'), item('tool', 'i2')])
    const timeline = buildTimeline(view)
    expect(timeline).toHaveLength(3)
    expect(timeline[0]).toMatchObject({ kind: 'tool-group', items: [{ id: 'i1' }] })
    expect(timeline[1]).toMatchObject({ kind: 'plan', item: { id: 'p1' } })
    expect(timeline[2]).toMatchObject({ kind: 'tool-group', items: [{ id: 'i2' }] })
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

describe('formatTokens', () => {
  it('leaves sub-thousand counts alone and compacts the rest', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(847)).toBe('847')
    expect(formatTokens(1200)).toBe('1.2k')
    expect(formatTokens(12_400)).toBe('12k')
  })

  it('drops the decimal on whole thousands', () => {
    expect(formatTokens(5000)).toBe('5k')
  })
})

describe('formatTurnTokens', () => {
  const started = 1_000_000
  const settled = started + 8_000 // an 8s turn

  it('reports the turn total and an output-derived rate', () => {
    // 800 generated over 8s.
    expect(formatTurnTokens(12_400, 800, started, settled)).toBe('12k tokens · 100 tok/s')
  })

  // The rate must never come from the total: the prompt and the cache reads
  // were not generated, so dividing 12.4k by 8s would claim 1550 tok/s.
  it('derives the rate from output alone, not the total', () => {
    const label = formatTurnTokens(12_400, 800, started, settled)
    expect(label).not.toContain('1550')
  })

  it('is absent entirely when the provider reported no usage', () => {
    expect(formatTurnTokens(undefined, undefined, started, settled)).toBeNull()
    expect(formatTurnTokens(0, 0, started, settled)).toBeNull()
  })

  it('drops the rate, not the count, when it cannot be measured', () => {
    // Nothing generated…
    expect(formatTurnTokens(900, 0, started, settled)).toBe('900 tokens')
    // …and a sub-second turn, where a rate would be noise.
    expect(formatTurnTokens(900, 400, started, started + 400)).toBe('900 tokens')
  })
})

describe('formatTurnEngine', () => {
  it('names the agent and the model that ran the turn', () => {
    expect(formatTurnEngine('claude', 'claude-sonnet-5')).toBe('claude · claude-sonnet-5')
  })

  // A turn that predates this field, or a provider that reports neither, must
  // fall back to the plain stamp rather than rendering a stray separator.
  it('returns null when neither is known', () => {
    expect(formatTurnEngine(undefined, undefined)).toBeNull()
    expect(formatTurnEngine('', '')).toBeNull()
  })

  // Half-known is still worth showing — which agent ran it answers most of the
  // question on its own.
  it('shows whichever half is known', () => {
    expect(formatTurnEngine('claude', undefined)).toBe('claude')
    expect(formatTurnEngine(undefined, 'claude-sonnet-5')).toBe('claude-sonnet-5')
  })
})
