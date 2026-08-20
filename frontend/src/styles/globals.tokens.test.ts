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

  it('defines the Palette A elevation ladder', () => {
    expect(css).toContain('--devdeck-base: #131616')
    expect(css).toContain('--devdeck-pane: #1a1d1d')
    expect(css).toContain('--devdeck-raised: #212525')
    expect(css).toContain('--devdeck-card: #262b2b')
    expect(css).toContain('--devdeck-hairline: rgba(255, 255, 255, 0.08)')
  })

  it('exposes the new surfaces as Tailwind color utilities', () => {
    expect(css).toContain('--color-devdeck-base: var(--devdeck-base)')
    expect(css).toContain('--color-devdeck-raised: var(--devdeck-raised)')
    expect(css).toContain('--color-devdeck-card: var(--devdeck-card)')
    expect(css).toContain('--color-devdeck-hairline: var(--devdeck-hairline)')
  })

  // The vendored AI Elements components style themselves through the shadcn
  // semantic layer. Two of those tokens were aliases of --background, which
  // made `bg-muted` invisible and `border-border` a hard 3:1 outline on every
  // card. Nothing outside src/components/{shadcn,ai-elements} reads them —
  // `border-border` and `bg-muted` have zero call sites — so re-pointing them
  // is inert for the rest of the app.
  it('gives the shadcn semantic layer distinct surfaces', () => {
    expect(css).toContain('--muted: var(--devdeck-raised)')
    expect(css).toContain('--card: var(--devdeck-raised)')
    expect(css).toContain('--secondary: var(--devdeck-card)')
    expect(css).toContain('--accent: var(--devdeck-card)')
    expect(css).toContain('--border: var(--devdeck-hairline)')
  })

  it('does not alias --muted to the pane again', () => {
    expect(css).not.toContain('--muted: var(--devdeck-pane)')
  })

  // message.tsx styles the user bubble with `is-user:dark` and
  // `group-[.is-user]:…`. Without the custom variant registered, Tailwind
  // emits no rule for the `is-user:` prefix and the bubble silently loses its
  // treatment.
  it('registers the is-user variant the Message component relies on', () => {
    expect(css).toContain('@custom-variant is-user')
  })

  // Streamdown ships its code-block copy/download buttons permanently visible
  // and there is no prop that hides them, so the only lever is this rule. If
  // it is dropped, every fenced block in the transcript grows a pair of
  // always-on buttons again.
  it('hover-gates the code-block actions Streamdown always renders', () => {
    expect(css).toContain(".chat-md [data-streamdown='code-block-actions']")
    expect(css).toContain(".chat-md [data-streamdown='code-block']:hover [data-streamdown='code-block-actions']")
    // Keyboard users must still reach them.
    expect(css).toContain(':focus-within [data-streamdown=\'code-block-actions\']')
  })
})
