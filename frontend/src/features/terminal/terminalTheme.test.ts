import { describe, expect, it } from 'vitest'
import { TERMINAL_THEME } from './Terminal'

describe('TERMINAL_THEME', () => {
  it('matches the pane surface so the terminal and its card are one plane', () => {
    expect(TERMINAL_THEME.background).toBe('#1a1d1d')
    expect(TERMINAL_THEME.cursorAccent).toBe('#1a1d1d')
  })

  it('uses the accent for the cursor and a readable selection', () => {
    expect(TERMINAL_THEME.cursor).toBe('#39c6bd')
    // the retired #315b5980 selection was tuned for the old darker surface
    expect(TERMINAL_THEME.selectionBackground).toBe('#39c6bd40')
  })

  it('uses the dim-pane token for recessive chrome, not the retired value', () => {
    expect(TERMINAL_THEME.brightBlack).toBe('#727575')
    expect(TERMINAL_THEME.brightBlack).not.toBe('#686e73')
  })
})
