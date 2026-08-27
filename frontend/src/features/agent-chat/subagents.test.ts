/**
 * Subagent observability — the reducer's roster fold and the timeline's
 * absorb-into-one-row rule.
 *
 * The wire shapes here are the ones the Go side actually emits (see
 * `backend/internal/agentcore/event/event.go`'s Task* payloads and
 * `provider/claude/subagent.go`), which in turn come from a live capture
 * against claude 2.1.246 — `docs/superpowers/specs/2026-08-26-subagent-observability-design.md`
 * has the evidence.
 */
import { describe, expect, it } from 'vitest'
import { emptyThreadView, reduceAgentEvents } from '@/features/agent-chat/eventReducer'
import { buildTimeline } from '@/features/agent-chat/timeline'
import type { SubagentEntry } from '@/features/agent-chat/timeline'
import type { AgentEvent, AgentThreadView } from '@/features/agent-chat/types'

const AGENT = 'toolu_spawn_1'
let seq = 0

function ev(type: string, payload: unknown, agentId?: string, createdAt = 1_000): AgentEvent {
  seq += 1
  return {
    seq,
    eventId: `ae-${seq}`,
    type: 'thread.activity-appended',
    threadId: 'w-abc',
    commandId: `ac-${seq}`,
    createdAt,
    payload: { type, ...(agentId ? { agentId } : {}), payload },
  }
}

/** A delta as `Ingestion.emitDelta` re-packs it — the one path where the
 *  attribution rides inside the payload rather than on the envelope. */
function delta(itemId: string, text: string, agentId?: string, stream = 'text'): AgentEvent {
  seq += 1
  return {
    seq,
    eventId: `ae-${seq}`,
    type: 'thread.activity-appended',
    threadId: 'w-abc',
    commandId: `ac-${seq}`,
    createdAt: 1_000,
    payload: { itemId, stream, text, sequence: 1, ...(agentId ? { agentId } : {}) },
  }
}

function toolEvents(itemId: string, name: string, toolCallId: string, agentId?: string): AgentEvent[] {
  return [
    ev('item.started', { itemType: 'tool_call', title: name, detail: { toolCallId, name } }, agentId),
    ev('item.completed', { itemType: 'tool_call', status: 'completed', detail: { command: 'echo hi' } }, agentId),
  ].map((e) => ({ ...e, payload: { ...(e.payload as object), itemId } as unknown }))
}

function started(extra: Record<string, unknown> = {}) {
  return ev(
    'task.started',
    { taskId: 'task-1', toolCallId: AGENT, title: 'Run three echo commands', role: 'general-purpose', depth: 1, ...extra },
    AGENT,
  )
}

describe('reduceAgentEvents — subagent roster', () => {
  it('starts every thread with an empty roster', () => {
    expect(emptyThreadView().subagents).toEqual([])
  })

  it('folds task.started into a running record with its identity', () => {
    const view = reduceAgentEvents(emptyThreadView(), [started()])
    expect(view.subagents).toHaveLength(1)
    const agent = view.subagents[0]
    expect(agent.id).toBe(AGENT)
    expect(agent.toolCallId).toBe(AGENT)
    expect(agent.taskId).toBe('task-1')
    expect(agent.title).toBe('Run three echo commands')
    expect(agent.role).toBe('general-purpose')
    expect(agent.status).toBe('running')
  })

  // A task.* event describes an agent; it is NOT a line in the conversation.
  // Appending one would put a duplicate entry beside the row the agent
  // already renders as.
  it('produces no chat item of its own', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      started(),
      ev('task.progress', { taskId: 'task-1', title: 'Running Print ALPHA' }, AGENT),
      ev('task.completed', { taskId: 'task-1', status: 'completed', summary: 'done' }, AGENT),
    ])
    expect(view.items).toHaveLength(0)
  })

  it('tracks the latest progress line and the tool it is running', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      started(),
      ev('task.progress', { taskId: 'task-1', title: 'Running Print ALPHA', lastToolName: 'Bash' }, AGENT),
      ev('task.progress', { taskId: 'task-1', title: 'Running Print BRAVO', lastToolName: 'Bash' }, AGENT),
    ])
    expect(view.subagents[0].progress).toBe('Running Print BRAVO')
    expect(view.subagents[0].lastTool).toBe('Bash')
  })

  // Providers report a subagent's usage as a RUNNING TOTAL. Summing the ticks
  // would report several times the real cost.
  it('merges usage by taking the larger value, never by summing', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      started(),
      ev('task.progress', { taskId: 'task-1', usage: { totalTokens: 19704, toolUses: 1 } }, AGENT),
      ev('task.progress', { taskId: 'task-1', usage: { totalTokens: 21165, toolUses: 3 } }, AGENT),
    ])
    expect(view.subagents[0].usage).toEqual({ totalTokens: 21165, toolUses: 3 })
  })

  it('is idempotent under a late or duplicated tick', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      started(),
      ev('task.progress', { taskId: 'task-1', usage: { totalTokens: 21165, toolUses: 3 } }, AGENT),
      // An out-of-order tick carrying an older total must not walk it back.
      ev('task.progress', { taskId: 'task-1', usage: { totalTokens: 19704, toolUses: 1 } }, AGENT),
    ])
    expect(view.subagents[0].usage).toEqual({ totalTokens: 21165, toolUses: 3 })
  })

  // The terminal row often carries only a grand total. Letting it overwrite
  // the breakdown would lose the tool count the progress rows established.
  it('keeps a known breakdown when the terminal row carries only a total', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      started(),
      ev('task.progress', { taskId: 'task-1', usage: { totalTokens: 21165, toolUses: 3 } }, AGENT),
      ev('task.completed', { taskId: 'task-1', status: 'completed', usage: { totalTokens: 21449 } }, AGENT),
    ])
    expect(view.subagents[0].usage).toEqual({ totalTokens: 21449, toolUses: 3 })
  })

  it('settles on the terminal status and carries the report back', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      started(),
      ev('task.completed', { taskId: 'task-1', status: 'completed', summary: 'I ran three commands.' }, AGENT),
    ])
    expect(view.subagents[0].status).toBe('completed')
    expect(view.subagents[0].summary).toBe('I ran three commands.')
  })

  it('records a failure and a stop distinctly', () => {
    const failed = reduceAgentEvents(emptyThreadView(), [
      started(),
      ev('task.completed', { taskId: 'task-1', status: 'failed' }, AGENT),
    ])
    expect(failed.subagents[0].status).toBe('failed')

    const stopped = reduceAgentEvents(emptyThreadView(), [
      started(),
      ev('task.updated', { taskId: 'task-1', status: 'stopped' }, AGENT),
    ])
    expect(stopped.subagents[0].status).toBe('stopped')
  })

  // A finished agent that receives a late in-flight tick must not start
  // spinning again.
  it('never walks a terminal status back to running', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      started(),
      ev('task.completed', { taskId: 'task-1', status: 'completed' }, AGENT),
      ev('task.updated', { taskId: 'task-1', status: 'running' }, AGENT),
    ])
    expect(view.subagents[0].status).toBe('completed')
  })

  // The backend repeats identity on every row precisely so a client whose
  // replay window no longer reaches task.started can still render the agent.
  it('reconstructs an agent whose start row fell outside the replay window', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      ev('task.progress', { taskId: 'task-1', title: 'Running Print ALPHA', role: 'general-purpose' }, AGENT),
    ])
    expect(view.subagents).toHaveLength(1)
    expect(view.subagents[0].role).toBe('general-purpose')
    expect(view.subagents[0].status).toBe('running')
  })

  it('keeps two concurrent subagents apart', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      started(),
      ev('task.started', { taskId: 'task-2', toolCallId: 'toolu_spawn_2', title: 'Second job' }, 'toolu_spawn_2'),
      ev('task.completed', { taskId: 'task-2', status: 'completed' }, 'toolu_spawn_2'),
    ])
    expect(view.subagents.map((a) => a.id)).toEqual([AGENT, 'toolu_spawn_2'])
    expect(view.subagents[0].status).toBe('running')
    expect(view.subagents[1].status).toBe('completed')
  })
})

describe('reduceAgentEvents — item attribution', () => {
  it('stamps a subagent delta onto its item, and leaves the parent unstamped', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      delta('parent-1', 'I will delegate this.'),
      delta('child-1', "I'll run the three commands.", AGENT),
    ])
    const parent = view.items.find((i) => i.id === 'parent-1')!
    const child = view.items.find((i) => i.id === 'child-1')!
    expect(parent.agentId).toBeUndefined()
    expect(child.agentId).toBe(AGENT)
  })

  it('stamps a subagent tool call', () => {
    const view = reduceAgentEvents(emptyThreadView(), toolEvents('child-tool', 'Bash', 'toolu_bash_1', AGENT))
    expect(view.items).toHaveLength(1)
    expect(view.items[0].agentId).toBe(AGENT)
    expect(view.items[0].toolName).toBe('Bash')
  })
})

describe('buildTimeline — a subagent costs the transcript one row', () => {
  function threadWithSubagent(): AgentThreadView {
    return reduceAgentEvents(emptyThreadView(), [
      delta('parent-1', 'I will delegate this.'),
      ...toolEvents('spawn-row', 'Agent', AGENT),
      started(),
      ...toolEvents('child-a', 'Bash', 'toolu_bash_1', AGENT),
      ...toolEvents('child-b', 'Bash', 'toolu_bash_2', AGENT),
      delta('child-text', 'I ran all three.', AGENT),
      ev('task.completed', { taskId: 'task-1', status: 'completed', summary: 'Ran three commands.' }, AGENT),
      delta('parent-2', 'Here is what it found.'),
    ])
  }

  // The invariant this whole feature turns on: whatever a subagent does
  // inside, the parent's narrative grows by exactly one line.
  it('renders one entry for the agent and none of its work in the main flow', () => {
    const entries = buildTimeline(threadWithSubagent())

    const subagentEntries = entries.filter((e): e is SubagentEntry => e.kind === 'subagent')
    expect(subagentEntries).toHaveLength(1)

    // No attributed item leaked into a message or tool-group entry.
    for (const entry of entries) {
      if (entry.kind === 'subagent') continue
      const items = entry.kind === 'tool-group' ? entry.items : [entry.item]
      for (const item of items) {
        expect(item.agentId, `item ${item.id} leaked into the main flow`).toBeUndefined()
      }
    }
  })

  it('carries the agent’s own work inside its entry', () => {
    const entries = buildTimeline(threadWithSubagent())
    const agent = entries.find((e): e is SubagentEntry => e.kind === 'subagent')!

    expect(agent.record.status).toBe('completed')
    expect(agent.record.summary).toBe('Ran three commands.')
    expect(agent.items.map((i) => i.id)).toEqual(['child-a', 'child-b', 'child-text'])
  })

  // The agent renders in place of the call that spawned it — the two are the
  // same event, and showing both would report the spawn twice.
  it('replaces the spawning tool row rather than adding a second row', () => {
    const entries = buildTimeline(threadWithSubagent())
    for (const entry of entries) {
      if (entry.kind !== 'tool-group') continue
      for (const item of entry.items) {
        expect(item.toolCallId).not.toBe(AGENT)
      }
    }
    // …and it lands where that call was: after the parent's first message,
    // before its closing one.
    const kinds = entries.map((e) => (e.kind === 'message' ? `message:${e.item.id}` : e.kind))
    expect(kinds).toEqual(['message:parent-1', 'subagent', 'message:parent-2'])
  })

  it('renders an agent that has announced itself but produced nothing yet', () => {
    const view = reduceAgentEvents(emptyThreadView(), [started()])
    const entries = buildTimeline(view)
    const agent = entries.find((e): e is SubagentEntry => e.kind === 'subagent')
    expect(agent).toBeDefined()
    expect(agent!.items).toEqual([])
    expect(agent!.record.title).toBe('Run three echo commands')
  })

  // A provider that reports no spawning tool id (or a replay that lost the
  // row) must still show the agent — anchored at its first visible work.
  it('anchors an unanchored agent at its first piece of work', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      delta('parent-1', 'before'),
      ev('task.started', { taskId: 'task-9', title: 'No anchor' }, 'agent-9'),
      delta('child-9', 'child speaks', 'agent-9'),
      delta('parent-2', 'after'),
    ])
    const kinds = buildTimeline(view).map((e) => (e.kind === 'message' ? `message:${e.item.id}` : e.kind))
    expect(kinds).toEqual(['message:parent-1', 'subagent', 'message:parent-2'])
  })

  // A spawn the CLI retracted (a real case: a model-refusal fallback
  // supersedes the tool_use and no task.started ever arrives) must stay an
  // ordinary tool row, not become a phantom agent.
  it('leaves a spawn with no task.started as an ordinary tool row', () => {
    const view = reduceAgentEvents(emptyThreadView(), toolEvents('spawn-row', 'Agent', 'toolu_retracted'))
    const entries = buildTimeline(view)
    expect(entries.filter((e) => e.kind === 'subagent')).toHaveLength(0)
    expect(entries.filter((e) => e.kind === 'tool-group')).toHaveLength(1)
  })

  it('keeps two concurrent subagents as two rows', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      ...toolEvents('spawn-1', 'Agent', AGENT),
      started(),
      ...toolEvents('spawn-2', 'Agent', 'toolu_spawn_2'),
      ev('task.started', { taskId: 'task-2', toolCallId: 'toolu_spawn_2', title: 'Second' }, 'toolu_spawn_2'),
      delta('child-1', 'one', AGENT),
      delta('child-2', 'two', 'toolu_spawn_2'),
    ])
    const agents = buildTimeline(view).filter((e): e is SubagentEntry => e.kind === 'subagent')
    expect(agents).toHaveLength(2)
    expect(agents[0].items.map((i) => i.id)).toEqual(['child-1'])
    expect(agents[1].items.map((i) => i.id)).toEqual(['child-2'])
  })

  it('is unaffected on a thread that never spawns one', () => {
    const view = reduceAgentEvents(emptyThreadView(), [delta('a', 'hello'), ...toolEvents('t', 'Read', 'toolu_r')])
    const entries = buildTimeline(view)
    expect(entries.filter((e) => e.kind === 'subagent')).toHaveLength(0)
    expect(entries.map((e) => e.kind)).toEqual(['message', 'tool-group'])
  })
})
