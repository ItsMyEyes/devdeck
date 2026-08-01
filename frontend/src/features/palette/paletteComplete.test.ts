import { describe, expect, it } from 'vitest'
import { computeCompletion } from '@/features/palette/paletteComplete'

describe('computeCompletion', () => {
  it('returns the remaining suffix of a prefix match', () => {
    expect(computeCompletion('ag', 'agent-new ')).toBe('ent-new ')
  })

  it('returns nothing when the query is empty', () => {
    expect(computeCompletion('', 'agent-new ')).toBe('')
  })

  it('returns nothing when there is no candidate', () => {
    expect(computeCompletion('ag', undefined)).toBe('')
  })

  it('returns nothing when the candidate is not a prefix match', () => {
    expect(computeCompletion('zz', 'agent-new ')).toBe('')
  })

  it('returns nothing when the query already equals the candidate', () => {
    expect(computeCompletion('agent-new ', 'agent-new ')).toBe('')
  })

  it('matches case-insensitively but preserves the candidate casing', () => {
    expect(computeCompletion('AG', 'agent-new ')).toBe('ent-new ')
  })

  it('completes only the last token, leaving earlier tokens alone', () => {
    expect(computeCompletion('agent-new ac', 'acme/api')).toBe('me/api')
  })

  it('returns nothing when the last token is empty', () => {
    expect(computeCompletion('agent-new ', 'acme/api')).toBe('')
  })
})
