import { describe, expect, it } from 'vitest'
import { describeBindingIssue } from '@/features/machines/bindingIssue'

describe('describeBindingIssue', () => {
  it('reports nothing while the status is still loading', () => {
    expect(describeBindingIssue(undefined)).toBeNull()
  })

  it('reports nothing when unknown', () => {
    expect(describeBindingIssue({ known: false })).toBeNull()
  })

  it('reports nothing when reachable and adopted', () => {
    expect(describeBindingIssue({ known: true, hubReachable: true, adopted: true })).toBeNull()
  })

  it('reports nothing for an adopted runtime even when the hub is unreachable this tick', () => {
    // The backend keeps `adopted` sticky across a tick with no fresh answer
    // from the runtime (pushBindingsOnce) — an already-synced runtime must
    // not flash a false "not reachable" alarm over a one-tick hub blip.
    expect(
      describeBindingIssue({ known: true, hubReachable: false, adopted: true, reason: 'serve_disabled' }),
    ).toBeNull()
  })

  it('explains an unreachable hub with a recognized reason code', () => {
    expect(describeBindingIssue({ known: true, hubReachable: false, reason: 'not_ready' })).toMatch(
      /Tailscale isn.t signed in/,
    )
  })

  it('falls back to a generic message for an unrecognized reason code', () => {
    expect(describeBindingIssue({ known: true, hubReachable: false, reason: 'serve_disabled' })).toMatch(
      /Settings › Network/,
    )
  })

  it('surfaces the runtime refusal reason when reachable but not adopted', () => {
    expect(
      describeBindingIssue({
        known: true,
        hubReachable: true,
        adopted: false,
        reason: 'this runtime was launched with its own --hub-url',
      }),
    ).toBe('this runtime was launched with its own --hub-url')
  })

  it('falls back to a generic message when reachable, not adopted, and no reason given', () => {
    expect(describeBindingIssue({ known: true, hubReachable: true, adopted: false })).toMatch(
      /has not accepted the connection/,
    )
  })
})
