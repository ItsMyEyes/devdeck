/**
 * Plan T8 — the plan card that sits in the transcript once the agent calls
 * `ExitPlanMode`. Ported from
 * `gg/t3code/apps/web/src/components/chat/ProposedPlanCard.tsx:148-205`
 * (design spec §6) onto this repo's own component set:
 *
 *   t3code                    | here
 *   -------------------------- | ----------------------------------------
 *   `ChatMarkdown`             | `MessageResponse` (`chat-md`, same as `MessagesTimeline.tsx:100`)
 *   `Badge variant="secondary"`| `@/components/ui/pill`
 *   `Menu`/`MenuItem`          | `TabStripPopoverMenu` + plain buttons (`ComposerStashMenu.tsx`'s pattern)
 *   `Dialog…`                  | `@/components/ui/dialog`
 *   `toastManager`             | `sonner`'s `toast`
 *   `writeProjectFile` atom    | `writeWorktreeFile(machine, worktreeId, {path, content})` (`lib/machineApi.ts:97`)
 *
 * Takes primitive props (`markdown`, `machine`, `worktreeId`), not a
 * `ChatItem` — it has no dependency on `ChatItemKind` (T7), so it is
 * independent of that task.
 */
import { useId, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { writeWorktreeFile } from '@/lib/machineApi'
import type { Machine } from '@/store/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/ui/pill'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { MessageResponse } from '@/components/ai-elements/message'
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  shouldCollapseProposedPlan,
  stripDisplayedPlanMarkdown,
} from '@/features/agent-chat/planMarkdown'

export interface ProposedPlanCardProps {
  /** The plan's markdown, verbatim from the `'plan'` `ChatItem.text` (T7/T9)
   *  — a primitive string, not the item itself. */
  markdown: string
  /** Threaded straight from the thread's machine/worktree, the same
   *  `machine?`/`worktreeId?` optionality `ChatComposer` already uses
   *  (`ChatComposer.tsx:105-106`) — a thread can run with neither, which is
   *  exactly when "Save to workspace" must be disabled. */
  machine?: Machine
  worktreeId?: string
}

const ACTION_ITEM =
  'w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-devdeck-fg hover:bg-devdeck-hover-wash ' +
  'disabled:cursor-not-allowed disabled:text-devdeck-fg-2 disabled:opacity-50 disabled:hover:bg-transparent'

export function ProposedPlanCard({ markdown, machine, worktreeId }: ProposedPlanCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false)
  const [savePath, setSavePath] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const savePathInputId = useId()

  const title = proposedPlanTitle(markdown) ?? 'Proposed plan'
  const canCollapse = shouldCollapseProposedPlan(markdown)
  const displayedMarkdown = stripDisplayedPlanMarkdown(markdown)
  const collapsedPreview = canCollapse ? buildCollapsedProposedPlanPreviewMarkdown(markdown, { maxLines: 10 }) : null
  const downloadFilename = buildProposedPlanMarkdownFilename(markdown)
  const exportContents = normalizePlanMarkdownForExport(markdown)
  const canSave = machine !== undefined && !!worktreeId

  function handleCopy() {
    navigator.clipboard.writeText(exportContents).then(
      () => toast.success('Copied plan to clipboard'),
      (error: unknown) => toast.error(error instanceof Error ? error.message : 'Could not copy plan'),
    )
  }

  function handleDownload() {
    void downloadPlanAsTextFile(downloadFilename, exportContents).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Could not save plan')
    })
  }

  function openSaveDialog() {
    if (!canSave) return
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename))
    setIsSaveDialogOpen(true)
  }

  async function handleSaveToWorkspace() {
    if (!machine || !worktreeId) return
    const path = savePath.trim()
    if (!path) {
      toast.warning('Enter a workspace path')
      return
    }

    setIsSaving(true)
    try {
      const saved = await writeWorktreeFile(machine, worktreeId, { path, content: exportContents })
      setIsSaveDialogOpen(false)
      toast.success('Plan saved to workspace', { description: saved.path })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save plan')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="rounded-[20px] border border-devdeck-hairline bg-devdeck-raised p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Pill color="var(--devdeck-accent)">Plan</Pill>
          <p className="truncate text-sm font-medium text-devdeck-fg">{title}</p>
        </div>
        <TabStripPopoverMenu
          trigger={<MoreHorizontal size={14} aria-hidden="true" />}
          triggerClassName="flex size-7 items-center justify-center rounded-md border border-devdeck-border-menu text-devdeck-fg-2 transition-colors hover:bg-devdeck-glass-solid hover:text-devdeck-fg"
          triggerTitle="Plan actions"
          triggerAriaLabel="Plan actions"
          align="end"
          open={menuOpen}
          onOpenChange={setMenuOpen}
        >
          <div className="flex w-56 flex-col gap-0.5 p-1">
            <button
              type="button"
              className={ACTION_ITEM}
              onClick={() => {
                handleCopy()
                setMenuOpen(false)
              }}
            >
              Copy to clipboard
            </button>
            <button
              type="button"
              className={ACTION_ITEM}
              onClick={() => {
                handleDownload()
                setMenuOpen(false)
              }}
            >
              Download as markdown
            </button>
            <button
              type="button"
              className={ACTION_ITEM}
              disabled={!canSave}
              onClick={() => {
                openSaveDialog()
                setMenuOpen(false)
              }}
            >
              Save to workspace
            </button>
          </div>
        </TabStripPopoverMenu>
      </div>

      <div className="mt-4">
        <div className={cn('relative', canCollapse && !expanded && 'max-h-104 overflow-hidden')}>
          <MessageResponse className="chat-md">
            {canCollapse && !expanded ? (collapsedPreview ?? '') : displayedMarkdown}
          </MessageResponse>
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-devdeck-raised via-devdeck-raised/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button size="sm" variant="secondary" onClick={() => setExpanded((value) => !value)}>
              {expanded ? 'Collapse plan' : 'Expand plan'}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSaving) setIsSaveDialogOpen(open)
        }}
      >
        <DialogTitle>Save plan to workspace</DialogTitle>
        <DialogDescription>Enter a path relative to the worktree root.</DialogDescription>
        <div className="mt-3">
          <label htmlFor={savePathInputId} className="grid gap-1.5">
            <span className="text-xs font-medium text-devdeck-fg">Workspace path</span>
            <Input
              id={savePathInputId}
              value={savePath}
              onChange={(event) => setSavePath(event.target.value)}
              placeholder={downloadFilename}
              spellCheck={false}
              disabled={isSaving}
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setIsSaveDialogOpen(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={() => void handleSaveToWorkspace()} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
