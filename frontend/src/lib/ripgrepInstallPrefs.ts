// Per-target "don't ask again" memory for ContentSearchPanel.tsx's ripgrep
// install-offer banner. Design decision 4
// (docs/superpowers/specs/2026-07-17-content-search-design.md): "ask once
// per target, remember the choice." Keyed by the same stable per-target id
// TerminalExplorer.tsx's filesRootKey already derives from a FilesTarget
// (qk.worktreeFilesRoot / qk.sshFilesRoot's cache-key arrays) — joined into
// one string since localStorage only stores strings, not reinvented.
//
// Defensive like browserTileBookmarks.ts's persist()/load(): private
// browsing or storage-disabled environments must degrade to "always ask"
// (never throw), not break the panel.

import { qk } from '@/features/data/keys'
import type { FilesTarget } from '@/features/terminal/filesTarget'

const STORAGE_KEY = 'devdeck.ripgrepInstall.dismissed'

/** Stable per-target id, reusing the exact key derivation TerminalExplorer's
 *  filesRootKey already uses for this same FilesTarget union. */
export function ripgrepInstallTargetId(target: FilesTarget): string {
  const key = target.kind === 'ssh' ? qk.sshFilesRoot(target.connectionId) : qk.worktreeFilesRoot(target.machine.id, target.worktreeId)
  return key.join(':')
}

function readDismissed(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

function writeDismissed(ids: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Private browsing / storage disabled / quota exceeded — the banner will
    // just keep reappearing for this target, which is an acceptable
    // "always ask" fallback rather than a broken panel.
  }
}

export function isRipgrepInstallDismissed(target: FilesTarget): boolean {
  return readDismissed().has(ripgrepInstallTargetId(target))
}

export function dismissRipgrepInstall(target: FilesTarget): void {
  const dismissed = readDismissed()
  dismissed.add(ripgrepInstallTargetId(target))
  writeDismissed(dismissed)
}
