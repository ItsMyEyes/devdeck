import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_STORAGE_KEY } from '@/features/theme/theme'

// `new URL(..., import.meta.url)` resolves against jsdom's document location
// rather than the file: base under this project's test environment — see the
// note in styles/globals.tokens.test.ts. Derive the paths instead.
const here = dirname(fileURLToPath(import.meta.url))
const indexHtml = readFileSync(join(here, '..', '..', '..', 'index.html'), 'utf8')
const globalsCss = readFileSync(join(here, '..', '..', 'styles', 'globals.css'), 'utf8')

// Execute the actual inline script, before React has loaded.
const prePaintScript = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1]
beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.className = 'dark'
})
afterEach(() => vi.restoreAllMocks())

describe('pre-paint theme script', () => {
  it.each([
    [null, false, 'dark'], ['invalid', false, 'dark'],
    ['light', true, 'light'], ['dark', false, 'dark'],
    ['system', false, 'light'], ['system', true, 'dark'],
  ] as const)('applies stored %s with OS dark=%s before first paint', (stored, dark, expected) => {
    if (stored !== null) window.localStorage.setItem(THEME_STORAGE_KEY, stored)
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: dark } as MediaQueryList)
    expect(prePaintScript).toBeTruthy()
    window.eval(prePaintScript!)
    expect(document.documentElement.classList.contains(expected)).toBe(true)
    expect(document.documentElement.classList.contains(expected === 'light' ? 'dark' : 'light')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe(expected)
  })
  it('defaults safely when localStorage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => window.eval(prePaintScript!)).not.toThrow()
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })
})

describe('light palette', () => {
  it('is declared before the reduced-transparency override', () => {
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
