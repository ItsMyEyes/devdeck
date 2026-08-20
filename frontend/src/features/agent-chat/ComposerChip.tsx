/**
 * Plan T2 — one node view shared by all three composer chip kinds
 * (`composerFileChip`, `composerSkillChip`, `composerTerminalContextChip`);
 * they differ only in icon and label. See the design spec's §5.
 *
 * The remove control renders INSIDE this component, never portalled out —
 * a ProseMirror node view's own DOM is the only DOM `posAtCoords` can
 * resolve back into a document position. This repo has already lost hover
 * controls that lived outside `view.dom` for exactly that reason (the
 * notion editor's gutter). T3 wraps this component in
 * `ReactNodeViewRenderer`; it stays presentational-only here.
 *
 * Visual treatment follows t3code's `FileTagChip` / `composerInlineChip.ts`
 * (`gg/t3code/apps/web/src/components/chat/FileTagChip.tsx`), translated to
 * this repo's semantic tokens — `border-border`, `bg-muted`,
 * `text-foreground`, `text-muted-foreground` — never t3code's raw color
 * values, and never `--secondary-label`, which doesn't exist here.
 */
import { Box, File, Terminal, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

export type ComposerChipKind = 'file' | 'skill' | 'terminal-context'

export interface ComposerChipProps {
  kind: ComposerChipKind
  label: string
  onRemove: () => void
  className?: string
}

const CHIP_ICON_BY_KIND: Record<ComposerChipKind, LucideIcon> = {
  file: File,
  skill: Box,
  'terminal-context': Terminal,
}

export function ComposerChip({ kind, label, onRemove, className }: ComposerChipProps) {
  const Icon = CHIP_ICON_BY_KIND[kind]

  return (
    <span
      contentEditable={false}
      data-composer-chip-kind={kind}
      className={cn(
        'inline-flex max-w-full select-none items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 align-middle text-xs font-medium leading-tight text-foreground',
        className,
      )}
    >
      <Icon data-chip-icon={kind} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
        aria-label={`Remove ${label}`}
        className="inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </span>
  )
}
