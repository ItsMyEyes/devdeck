import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Path derivation copies globals.tokens.test.ts: under this project's jsdom
// environment `new URL('./x', import.meta.url)` resolves against jsdom's
// document location, not the `file:` base, so join/dirname is used instead.
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')
const cssPath = join(repoRoot, 'frontend', 'src', 'styles', 'globals.css')

const SOURCES = ['StatsPane.tsx', 'MetricChart.tsx']

const workingTreeCss = readFileSync(cssPath, 'utf8')

/** The last-committed globals.css. A design-token retune is in flight in this
 *  working tree, so a class that resolves against the *uncommitted* CSS can
 *  still be a dangling token on the branch: Tailwind v4 emits no rule at all
 *  for an unknown `--color-devdeck-*` key, and the element silently renders
 *  with no background / inherited colour. The stats pane must therefore only
 *  use tokens defined in BOTH revisions, so it renders correctly whether or
 *  not the retune has landed. */
function committedCss(): string | null {
  try {
    return execFileSync('git', ['show', 'HEAD:frontend/src/styles/globals.css'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

const headCss = committedCss()

/** `bg-devdeck-accent`, `text-devdeck-fg-2`, … → `devdeck-accent`, `devdeck-fg-2`. */
function utilityTokens(src: string): string[] {
  return [...src.matchAll(/[a-z]+-(devdeck-[a-z0-9]+(?:-[a-z0-9]+)*)/g)].map((m) => m[1])
}

/** `var(--devdeck-accent)` → `devdeck-accent`. */
function varTokens(src: string): string[] {
  return [...src.matchAll(/var\(--(devdeck-[a-z0-9]+(?:-[a-z0-9]+)*)\)/g)].map((m) => m[1])
}

const used = SOURCES.flatMap((file) => {
  const src = readFileSync(join(here, file), 'utf8')
  return [
    ...utilityTokens(src).map((t) => ({ file, token: `--color-${t}` })),
    ...varTokens(src).map((t) => ({ file, token: `--${t}` })),
  ]
})

const unique = [...new Map(used.map((u) => [u.token, u])).values()].sort((a, b) =>
  a.token.localeCompare(b.token),
)

function defines(css: string, token: string): boolean {
  return new RegExp(`${token}\\s*:`).test(css)
}

describe('stats pane design tokens', () => {
  it('finds the devdeck tokens the stats pane actually uses', () => {
    expect(unique.length).toBeGreaterThan(0)
  })

  it.each(unique)('$token ($file) is defined in the working-tree globals.css', ({ token }) => {
    expect(defines(workingTreeCss, token)).toBe(true)
  })

  it.skipIf(headCss === null).each(unique)(
    '$token ($file) is defined in the last-committed globals.css',
    ({ token }) => {
      expect(defines(headCss!, token)).toBe(true)
    },
  )
})
