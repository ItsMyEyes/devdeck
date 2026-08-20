/**
 * Pending image attachments for one composer draft — the sibling
 * `data-slot="composer-attachments"` row `ChatComposer.tsx` mounts between
 * `composer-panels` and the prompt editor (design spec §"Where they
 * render" — A's slot stays reserved for its own content, this is a
 * separate row, not nested inside it).
 *
 * Owns the whole pending-upload lifecycle: `addFiles` is exposed
 * imperatively so paste, drop, and the paperclip button in `ChatComposer.tsx`
 * all converge on the same path (design spec §"Capture"); each file is
 * downscaled (`imageCompression.ts`'s `downscaleImage`) and then uploaded
 * immediately, on add — not deferred to send — so the send path stays
 * synchronous and the progress ring has somewhere to live (design spec
 * §"Upload immediately, on add").
 *
 * Deliberately NOT controlled by the parent: `ChatComposer` never sees a
 * pending upload mid-flight, only the finished `AgentAttachmentRef[]` it
 * reads through this ref at submit time (`attachments()`) — the same
 * "read imperatively at the moment that matters" shape `ComposerPromptEditor`'s
 * `insertChip` ref uses, for the same reason: a per-progress-event-shaped
 * React prop for something driven by an XHR callback on its own timeline
 * would be the tail wagging the dog.
 *
 * `.claude/rules/frontend.md`: every data surface renders explicit loading
 * and error states — an upload that fails is left in the list with a visible
 * error, never silently dropped.
 */
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { downscaleImage } from '@/features/agent-chat/imageCompression'
import { uploadAgentAttachment } from '@/lib/machineApi'
import type { TransferProgress } from '@/lib/machineClient'
import type { AgentAttachment, Machine } from '@/store/types'

/** The shape a completed upload takes on `thread.turn.start`'s payload and
 *  on `ChatItem.attachments` — matches `provider.Attachment`'s JSON tags
 *  exactly (`id`/`kind`/`mime`/`name`), deliberately not `AgentAttachment`'s
 *  `mimeType`: this is the wire reference, not the store record it was
 *  created from (see the plan's "naming inconsistency" note). */
export interface AgentAttachmentRef {
  id: string
  kind: string
  mime: string
  name: string
}

interface PendingAttachment {
  localId: string
  file: File
  previewUrl: string
  progress: number
  status: 'uploading' | 'done' | 'error'
  attachment?: AgentAttachment
  error?: string
}

export interface ComposerAttachmentsHandle {
  /** Wired to paste, drop, and the paperclip button. Non-image files are
   *  silently skipped — the paperclip's own `accept="image/*"` input already
   *  filters, but paste/drop hand this whatever the OS clipboard/drag
   *  payload actually contains. */
  addFiles: (files: FileList | File[]) => void
  /** Only completed uploads — an item still `uploading` or `error` has no
   *  server-side id yet, so it cannot ride the turn. Read once, at submit;
   *  never mutated in place. */
  attachments: () => AgentAttachmentRef[]
  /** Clears every pending item and revokes its preview object URL. Called by
   *  `ChatComposer.submit()` alongside the text clear. */
  clear: () => void
}

export interface ComposerAttachmentsProps {
  machine: Machine
  /** The backend thread id attachments are scoped to
   *  (`POST /api/agent/threads/{threadId}/attachments`) — an upload may
   *  race ahead of the thread's own row (see `domain.AgentAttachment`'s doc
   *  comment), so this only needs to be a stable key, not an existing one. */
  threadId: string
}

function nextLocalId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `pending-${Math.random().toString(36).slice(2)}`
}

export const ComposerAttachments = forwardRef<ComposerAttachmentsHandle, ComposerAttachmentsProps>(
  function ComposerAttachments({ machine, threadId }, ref) {
    const [pending, setPending] = useState<PendingAttachment[]>([])
    // `attachments()`/`clear()` fire from an imperative caller (a submit
    // handler), outside React's render cycle — reading `pending` there
    // directly would close over whatever render happened to define the
    // callback, which can be stale by the time it actually runs.
    const pendingRef = useRef<PendingAttachment[]>(pending)
    pendingRef.current = pending

    function patchItem(localId: string, patch: Partial<PendingAttachment>) {
      setPending((items) => items.map((item) => (item.localId === localId ? { ...item, ...patch } : item)))
    }

    async function addOne(file: File) {
      const localId = nextLocalId()
      const previewUrl = URL.createObjectURL(file)
      setPending((items) => [...items, { localId, file, previewUrl, progress: 0, status: 'uploading' }])
      try {
        const uploadFile = await downscaleImage(file)
        const uploaded = await uploadAgentAttachment(machine, threadId, uploadFile, (progress: TransferProgress) => {
          patchItem(localId, { progress: progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0 })
        })
        patchItem(localId, { status: 'done', progress: 100, attachment: uploaded })
      } catch (err) {
        patchItem(localId, { status: 'error', error: err instanceof Error ? err.message : 'Upload failed' })
      }
    }

    function addFiles(files: FileList | File[]) {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue
        void addOne(file)
      }
    }

    function removeItem(localId: string) {
      setPending((items) => {
        const target = items.find((item) => item.localId === localId)
        if (target) URL.revokeObjectURL(target.previewUrl)
        return items.filter((item) => item.localId !== localId)
      })
    }

    useImperativeHandle(ref, () => ({
      addFiles,
      attachments: () =>
        pendingRef.current
          .filter((item) => item.status === 'done' && item.attachment !== undefined)
          .map((item) => ({
            id: item.attachment!.id,
            kind: 'image',
            mime: item.attachment!.mimeType,
            name: item.attachment!.name,
          })),
      clear: () => {
        for (const item of pendingRef.current) URL.revokeObjectURL(item.previewUrl)
        setPending([])
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }))

    return (
      // `hidden` rather than `null` when there is nothing pending: the strip
      // keeps its place in the composer's stack, but an empty div is still a
      // flex child of `ChatComposer`'s surface and still collects that
      // surface's `gap` on both sides — dead vertical space in every composer
      // that has no attachment, which is most of them.
      <div
        data-slot="composer-attachments"
        className={cn(pending.length > 0 ? 'flex flex-wrap gap-2 pb-1' : 'hidden')}
      >
        {pending.map((item) => (
          <div
            key={item.localId}
            className="group relative size-14 shrink-0 overflow-hidden rounded-lg border border-devdeck-hairline bg-devdeck-raised"
          >
            <img src={item.previewUrl} alt={item.file.name} className="size-full object-cover" />
            {item.status === 'uploading' ? (
              <div
                role="status"
                aria-label={`Uploading ${item.file.name}`}
                className="absolute inset-0 flex items-center justify-center bg-black/55 text-[10px] font-medium text-white"
              >
                {item.progress}%
              </div>
            ) : null}
            {item.status === 'error' ? (
              <div
                role="alert"
                title={item.error}
                className="absolute inset-0 flex items-center justify-center bg-devdeck-red-tint-strong text-center text-[10px] font-medium text-devdeck-err"
              >
                Failed
              </div>
            ) : null}
            <button
              type="button"
              aria-label={`Remove ${item.file.name}`}
              onClick={() => removeItem(item.localId)}
              className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            >
              <X size={10} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    )
  },
)
