/**
 * A tour step whose anchor no component renders does not fail loudly — it just
 * highlights nothing, and `buildTourSteps` quietly drops it, so the tour gets
 * shorter and nobody notices. That is exactly the failure a unit test of
 * `buildTourSteps` cannot catch: it takes the DOM it is given.
 *
 * So this walks the real source tree and asserts each declared anchor is
 * actually attached to an element somewhere, and that nothing attaches an
 * anchor the union has since dropped.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { TOUR_ANCHORS, type TourAnchor } from '@/features/tour/tourAnchors'

// `dirname(fileURLToPath(...))` rather than `new URL('../../', import.meta.url)`
// for the reason globals.tokens.test.ts documents: under jsdom the global URL
// constructor resolves a relative reference against the document's
// `http://localhost` origin instead of the `file:` base it was handed.
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** Matches the call the JSX spreads: `{...tourAnchor('agents-new')}`. */
const USAGE = /\btourAnchor\(\s*'([a-z-]+)'\s*\)/g

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      collectSources(path, out)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(path)
    }
  }
  return out
}

/** Anchor → the files that attach it. Excludes `tourAnchors.ts` itself, which
 *  only ever *declares* them. */
function usagesBySource(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const path of collectSources(SRC_ROOT)) {
    if (path.endsWith(join('features', 'tour', 'tourAnchors.ts'))) continue
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(USAGE)) {
      const list = found.get(match[1]) ?? []
      list.push(path)
      found.set(match[1], list)
    }
  }
  return found
}

describe('tour anchors are attached to real chrome', () => {
  const usages = usagesBySource()

  // The reverse direction — attaching an anchor that no longer exists — is
  // already a compile error, since `tourAnchor` takes the union and not a
  // string, so it is not re-checked here.
  it.each(TOUR_ANCHORS)('%s is rendered by at least one component', (anchor: TourAnchor) => {
    expect(usages.get(anchor) ?? []).not.toHaveLength(0)
  })
})
