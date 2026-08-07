import { describe, expect, it } from 'vitest'
import { FOLLOW_REARM_THRESHOLD_PX, shouldFollow } from '@/features/agent-chat/scrollAnchoring'

describe('shouldFollow', () => {
  it('follows when pinned to the bottom', () => {
    expect(shouldFollow({ contentLength: 1000, scroll: 800, scrollLength: 200 }, 0)).toBe(true)
  })

  // A strict 1px check re-arms while the user is reading history and yanks
  // them back down on the next streamed chunk. The band prevents that.
  it('does not follow when the user has scrolled up past the band', () => {
    expect(shouldFollow({ contentLength: 1000, scroll: 500, scrollLength: 200 }, 0)).toBe(false)
  })

  it('still follows within the re-arm band', () => {
    const scroll = 800 - (FOLLOW_REARM_THRESHOLD_PX - 1)
    expect(shouldFollow({ contentLength: 1000, scroll, scrollLength: 200 }, 0)).toBe(true)
  })

  it('accounts for the composer overlay inset', () => {
    expect(shouldFollow({ contentLength: 1120, scroll: 800, scrollLength: 200 }, 120)).toBe(true)
  })
})
