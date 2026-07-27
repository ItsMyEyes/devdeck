// Archive-name helpers for the explorer's zip download. Kept free of React
// imports (unlike the rest of this feature folder) so archiveName.test.ts can
// exercise them in a plain node/tsx run — see that file's header.

import type { SelectedEntry } from './fileTreeSelection'

const FALLBACK_NAME = 'selection.zip'

/** Default archive name offered by ArchiveNameDialog: a lone entry lends its
 *  own name, anything else is just "selection". */
export function archiveDefaultName(entries: readonly SelectedEntry[]): string {
  if (entries.length === 1) return `${entries[0]?.name ?? 'selection'}.zip`
  return FALLBACK_NAME
}

/**
 * Cleans a user-typed archive name into a single safe filename.
 *
 * Separators are stripped rather than rejected — the name only ever reaches
 * `downloadBlob`'s `a.download` attribute, where a path would be silently
 * mangled by the browser anyway, so quietly flattening it is friendlier than
 * blocking the download.
 */
export function normalizeArchiveName(raw: string): string {
  const flat = raw.replace(/[/\\]/g, '').trim()
  if (!flat) return FALLBACK_NAME
  return flat.toLowerCase().endsWith('.zip') ? flat : `${flat}.zip`
}
