import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// `new URL(..., import.meta.url)` resolves against jsdom's document location
// rather than the file: base under this project's test environment — see the
// note in styles/globals.tokens.test.ts. Derive the paths instead.
const here = dirname(fileURLToPath(import.meta.url))
const indexHtml = readFileSync(join(here, '..', '..', '..', 'index.html'), 'utf8')
const globalsCss = readFileSync(join(here, '..', '..', 'styles', 'globals.css'), 'utf8')

/**
 * The pre-paint script in `index.html` deliberately duplicates the class
 * names `theme.ts`'s `applyTheme` uses — the app bundle has not loaded when
 * it runs, so it cannot import them. That duplication is only safe while the
 * two agree, and nothing else enforces that.
 */
describe('pre-paint theme script', () => {
  it('forces the dark class and removes light', () => {
    expect(indexHtml).toContain("classList.add('dark')")
    expect(indexHtml).toContain("classList.remove('light')")
    expect(indexHtml).toContain("colorScheme = 'dark'")
  })

  /** Dark is the only theme, so an existing user sees no change. */
  it('leaves dark on <html> as the default before the script runs', () => {
    expect(indexHtml).toMatch(/<html lang="en" class="dark">/)
  })
})

/**
 * The `.light` palette in globals.css is unreachable while light mode is
 * disabled (`applyTheme` never adds the `.light` class), but the block stays
 * in place so re-enabling the feature is a change to `theme.ts` only. These
 * guards keep that block intact rather than letting it silently bit-rot.
 */
describe('light palette (currently unreachable)', () => {
  it('is declared, and after the reduced-transparency block that overrides it', () => {
    const light = globalsCss.indexOf('\n.light {')
    const reduced = globalsCss.indexOf('@media (prefers-reduced-transparency: reduce)')
    expect(light).toBeGreaterThan(0)
    // Equal specificity, so source order decides which wins; the media block
    // has to come last or reduced-transparency stops removing the blur.
    expect(reduced).toBeGreaterThan(light)
  })

  /**
   * The light block only restates the RAW tokens; the semantic layer aliases
   * them. If a raw token used by components were missed it would keep its dark
   * value on a light page, so the ones carrying surface and text colour are
   * checked explicitly.
   */
  it('restates every raw token that carries a surface or text colour', () => {
    const block = globalsCss.slice(globalsCss.indexOf('\n.light {'))
    const body = block.slice(0, block.indexOf('\n}'))
    for (const token of [
      '--devdeck-pane',
      '--devdeck-base',
      '--devdeck-raised',
      '--devdeck-card',
      '--devdeck-glass',
      '--devdeck-glass-solid',
      '--devdeck-card-wash',
      '--devdeck-fg',
      '--devdeck-fg-2',
      '--devdeck-line',
      '--devdeck-accent',
      '--devdeck-accent-ink',
      '--devdeck-on',
      '--devdeck-hairline',
      '--devdeck-border',
      '--devdeck-hover-wash',
      '--nt-bg',
      '--nt-text',
    ]) {
      expect(body).toContain(`${token}:`)
    }
  })
})
