/**
 * Shared display + match facets for anything that represents a project in the
 * palette (project rows, worktree rows, the "New Agent…" drill-down, and the
 * `agent-new` verb). One derivation, so path elision and the machine-name
 * fallback can't drift between the four call sites.
 */

/** Structural subset of `Project` — only the fields this module reads. */
export interface ProjectFacetSource {
  name: string
  path: string
  machineId: string
}

export interface ProjectFacets {
  machineName: string
  /** `home-laptop · …/superapps/core` — machine first, because the row
   *  truncates its subtitle's tail. */
  subtitle: string
  /** Fuzzy-matched. Short values only. */
  keywords: string[]
  /** Substring-matched (see D1 in the design doc). The full, un-elided path. */
  literalKeywords: string[]
}

/**
 * Head-elides a path to its last two segments for display, because the
 * palette row truncates its subtitle's *tail* — the part that actually
 * disambiguates same-named projects. The full path is still what gets
 * matched (`literalKeywords`), only the display form is shortened.
 *
 *   '~/Documents/freelance/mabes/superapps/core' -> '…/superapps/core'
 *   '~/Documents/deps'                           -> '…/Documents/deps'
 *   '/srv'                                        -> '/srv'
 *   ''                                             -> ''
 */
function elidePath(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '')
  if (segments.length <= 2) return path
  return `…/${segments.slice(-2).join('/')}`
}

export function projectFacets(project: ProjectFacetSource, machines: { id: string; name: string }[]): ProjectFacets {
  // Empty machineId means local/unassigned (see `resolveTabLabel` in
  // useCommandPalette.ts) — an unknown id (stale/deleted machine) falls back
  // the same way rather than surfacing a raw id or blank subtitle.
  const machineName = machines.find((m) => m.id === project.machineId)?.name ?? 'local'
  const elided = elidePath(project.path)

  return {
    machineName,
    subtitle: project.path === '' ? machineName : `${machineName} · ${elided}`,
    keywords: [machineName],
    literalKeywords: project.path === '' ? [] : [project.path],
  }
}
