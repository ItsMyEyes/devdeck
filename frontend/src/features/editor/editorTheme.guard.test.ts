import { describe, expect, it } from 'vitest'
import {
  ONE_DARK_PRO_DARKER,
  ONE_DARK_PRO_DARKER_TOKEN,
  oneDarkProDarkerShikiTheme,
} from '@/lib/oneDarkProDarker'
import { ONE_DARK_PRO_DARKER_SEMANTIC_TOKEN_COLORS } from '@/lib/oneDarkProDarker.tokenColors'
import { devdeckDarkTheme, devdeckLightTheme } from './editorTheme'

/**
 * The One Dark Pro Darker palette reaches the screen through two renderers
 * that disagree about what a colour looks like, and neither complains when it
 * is handed the other one's spelling. Both halves are pinned here.
 */
describe('monaco theme colours', () => {
  /**
   * Monaco's `parseTokenTheme` wants a bare six-digit hex — it is not CSS —
   * and drops any rule whose colour it cannot parse, leaving that token at the
   * inherited base colour with nothing logged. Since the palette is stored
   * `#`-prefixed for shiki's benefit, this is the seam where a hand-written
   * `foreground: ONE_DARK_PRO_DARKER.purple` would fail silently.
   */
  it.each([
    ['dark', devdeckDarkTheme],
    ['light', devdeckLightTheme],
  ])('spells every %s rule colour the way monaco parses it', (_name, theme) => {
    expect(theme.rules.length).toBeGreaterThan(0)
    for (const rule of theme.rules) {
      expect(`${rule.token}=${rule.foreground}`).toMatch(/=[0-9a-fA-F]{6}$/)
    }
  })

  /** The workbench half of the same object *does* take CSS colours. */
  it.each([
    ['dark', devdeckDarkTheme],
    ['light', devdeckLightTheme],
  ])('keeps the %s workbench colours CSS-shaped', (_name, theme) => {
    for (const [key, value] of Object.entries(theme.colors)) {
      expect(`${key}=${value}`).toMatch(/=#[0-9a-fA-F]{6,8}$/)
    }
  })

  it('derives the bare-hex palette from the CSS one', () => {
    for (const [name, hex] of Object.entries(ONE_DARK_PRO_DARKER)) {
      expect(`#${ONE_DARK_PRO_DARKER_TOKEN[name as keyof typeof ONE_DARK_PRO_DARKER]}`).toBe(hex)
    }
  })

  /**
   * Semantic tokens arrive from a language server, not from a TextMate scope,
   * so nothing in the vendored rules covers them — the dark theme's semantic
   * entries are a hand-written mapping onto the upstream theme's own
   * `semanticTokenColors`, and this is what keeps that mapping honest.
   */
  it.each([
    ['enumMember', 'enumMember'],
    ['macro', 'macro'],
    ['variable.readonly', 'variable.constant'],
    ['variable.definition.readonly', 'variable.constant'],
    ['variable.predefined', 'variable.defaultLibrary'],
  ])('paints the %s rule with One Dark’s own %s colour', (token, upstream) => {
    const rule = devdeckDarkTheme.rules.find((candidate) => candidate.token === token)
    expect(`#${rule?.foreground}`).toBe(ONE_DARK_PRO_DARKER_SEMANTIC_TOKEN_COLORS[upstream].foreground)
  })
})

describe('shiki theme', () => {
  /**
   * `@streamdown/code` registers the theme by object but then asks shiki for it
   * by `theme.name`, so a nameless theme silently highlights as `"custom"` —
   * or, once two of them exist, as each other.
   */
  it('carries the name its lookups go through', () => {
    expect(oneDarkProDarkerShikiTheme.name).toBe('one-dark-pro-darker')
    expect(oneDarkProDarkerShikiTheme.type).toBe('dark')
  })

  /**
   * Shiki's `normalizeTheme` reads a theme's foreground and background out of
   * `colors` when there is no scope-less global rule. Drop these and every
   * code block falls back to shiki's `#bbbbbb` on `#1e1e1e` stand-in.
   */
  it('states the fg/bg shiki reads the code surface from', () => {
    expect(oneDarkProDarkerShikiTheme.colors?.['editor.foreground']).toBe(ONE_DARK_PRO_DARKER.fg)
    expect(oneDarkProDarkerShikiTheme.colors?.['editor.background']).toMatch(/^#[0-9a-fA-F]{6}$/)
  })

  /** The vendored rules are the point of the theme; an empty array still loads. */
  it('vendors the upstream rule set', () => {
    expect(oneDarkProDarkerShikiTheme.tokenColors?.length).toBeGreaterThan(200)
    const scopes = oneDarkProDarkerShikiTheme.tokenColors?.flatMap((rule) =>
      typeof rule.scope === 'string' ? rule.scope.split(',') : (rule.scope ?? []),
    )
    expect(scopes).toContain('entity.name.function')
  })

  /**
   * Darker *is* One Dark Pro minus its four italic rules. If a re-vendor picks
   * up the base theme's file by mistake, the colours would all still match and
   * only the italics would give it away.
   */
  it('is the no-italics variant', () => {
    const italic = oneDarkProDarkerShikiTheme.tokenColors?.filter(
      (rule) => rule.settings.fontStyle?.includes('italic'),
    )
    expect(italic).toEqual([])
  })
})
