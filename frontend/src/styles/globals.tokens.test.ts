import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// `new URL('./globals.css', import.meta.url)` is the plan's original
// approach, but under this project's jsdom test environment the global `URL`
// constructor (which `node:url`'s named `URL` export also aliases) resolves
// relative URLs against jsdom's `http://localhost:3000/` document location
// instead of the `file:` base passed as the second argument. Deriving the
// path with `dirname`/`join` sidesteps that relative-URL resolution entirely.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'globals.css'), 'utf8')

/** Hexes the retune removes. If one reappears, someone reintroduced a retired
 *  surface, border, or text level instead of using the new token. */
const RETIRED = [
  '#292b2f', // --devdeck-border, the 440-use hairline
  '#303237', // --devdeck-border-card
  '#3b3f45', // --devdeck-border-menu
  '#35383d', // --devdeck-border-strong, measured 1.01:1 on the glass card
  '#315b59', // --devdeck-border-accent, the old focus ring at 1.58:1
  '#555b60', // --devdeck-fg-2, the old placeholder at 1.74:1
  '#161719', // --devdeck-pane
  '#1d1e21', // --devdeck-card-wash
  '#202124', // --devdeck-glass-solid
  '#242629', // --devdeck-glass-solid
  '#2a2c30', // --devdeck-glass-solid
  '#111214', // --devdeck-pane
]

describe('globals.css token layer', () => {
  it.each(RETIRED)('no longer defines the retired value %s', (hex) => {
    expect(css.toLowerCase()).not.toContain(hex)
  })

  it('defines exactly three radius steps', () => {
    expect(css).toContain('--r-container: 14px')
    expect(css).toContain('--r-control: 10px')
    expect(css).toContain('--r-micro: 5px')
  })

  it('keeps the glass desaturating, not saturating', () => {
    const match = css.match(/saturate\(([\d.]+)\)/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeLessThan(1)
  })
})
