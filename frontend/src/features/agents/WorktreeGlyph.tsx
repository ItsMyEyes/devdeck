import { GitBranch, House } from 'lucide-react'

/** Branch (⎇) vs project-root (⌂) marker, colored consistently across the app. */
export function WorktreeGlyph({ root, size = 12 }: { root?: boolean; size?: number }) {
  const color = root ? 'var(--devdeck-purple)' : 'var(--devdeck-fg-2)'
  return root ? (
    <House size={size} style={{ color }} className="flex-none" />
  ) : (
    <GitBranch size={size} style={{ color }} className="flex-none" />
  )
}

export function worktreeColor(root?: boolean) {
  return root ? 'var(--devdeck-purple)' : 'var(--devdeck-fg-2)'
}
