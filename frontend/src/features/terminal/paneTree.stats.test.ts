import { describe, expect, it } from 'vitest'
import { createStatsContent, statsTargetKey } from './paneTree'
import type { StatsTarget } from './paneTree'

describe('statsTargetKey', () => {
  it('namespaces machine and ssh targets so ids cannot collide', () => {
    const machine: StatsTarget = { kind: 'machine', machineId: 'x1' }
    const ssh: StatsTarget = { kind: 'ssh', connectionId: 'x1' }

    expect(statsTargetKey(machine)).toBe('stats:machine:x1')
    expect(statsTargetKey(ssh)).toBe('stats:ssh:x1')
    expect(statsTargetKey(machine)).not.toBe(statsTargetKey(ssh))
  })
})

describe('createStatsContent', () => {
  it('uses the target key as the content id so re-opening refocuses', () => {
    const target: StatsTarget = { kind: 'machine', machineId: 'm1' }

    const first = createStatsContent(target, 'prod-runtime')
    const second = createStatsContent({ kind: 'machine', machineId: 'm1' }, 'prod-runtime')

    expect(first.id).toBe(statsTargetKey(target))
    expect(first.id).toBe(second.id)
  })

  it('carries kind, label and target', () => {
    const content = createStatsContent({ kind: 'ssh', connectionId: 'c9' }, 'prod-web')

    expect(content.kind).toBe('stats')
    expect(content.label).toBe('prod-web')
    expect(content.target).toEqual({ kind: 'ssh', connectionId: 'c9' })
  })
})
