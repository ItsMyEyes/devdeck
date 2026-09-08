/**
 * `ChatHeader.tsx` action: publishes the CURRENT thread to Telegram, or (once
 * bound) offers to unpublish it. A "binding" is Telegram-remote-chat's unit
 * of publication — one thread to one (chatId, topicId) destination — the
 * same shape `SocksPublishSection`'s publish toggle plays for the SOCKS5
 * proxy, but per-thread rather than per-machine.
 *
 * §2a of docs/superpowers/plans/2026-08-18-telegram-remote-chat.md replaced
 * the original chatId/topicId form: Telegram's own UI never shows those
 * numbers, so the form was unusable. Instead the dialog shows a command to
 * copy — `/init <threadId>` — the operator sends it in the destination chat
 * or forum topic, and the backend bridge reads `chat.id`/`message_thread_id`
 * off that very message and writes the binding itself. This component's only
 * job is to show the command, copy it, and poll the binding list until that
 * write lands — the same shape `TelegramSection.tsx`'s pairing-code block
 * uses for the same kind of "something else writes this row" wait.
 *
 * There is no "get one binding" route (see Task 6's route table), only
 * `GET /api/telegram/bindings` (the whole list for this machine), so this
 * component fetches the list and finds this thread's row itself.
 */
import { useMemo, useState } from 'react'
import { Copy, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { chatHeaderActionClassName } from '@/features/agent-chat/ChatHeader'
import {
  useDeleteTelegramBinding,
  useTelegramBindings,
  useTelegramConfig,
  type TelegramTarget,
} from '@/lib/telegramApi'
import { cn } from '@/lib/utils'
import { useWorkspaces } from '@/features/data/queries'
import { tourAnchor } from '@/features/tour/tourAnchors'
import type { TelegramBinding } from '@/store/types'

/**
 * Whether `/init` would land anywhere. With no token, or a token but the
 * bridge switched off, no long-poll loop is running on the target process —
 * `/init` would be sent into a void and the operator would see silence with
 * no explanation. `'ready'` is the only state that offers the command.
 *
 * Deliberately irrelevant once a binding already exists: an existing
 * binding was proven to work at publish time, and stays visible/unpublishable
 * even if the token was later removed — see `TelegramPublishButton`.
 */
type BridgeReadiness = 'ready' | 'no-token' | 'disabled'

function readinessOf(hasToken: boolean, enabled: boolean): BridgeReadiness {
  if (!hasToken) return 'no-token'
  if (!enabled) return 'disabled'
  return 'ready'
}

/** How often the binding list is re-read while the dialog is open and this
 *  thread is still unbound. Same shape and cadence as TelegramSection's
 *  `PAIRING_POLL_MS` — a row written by the bridge, from the Telegram side,
 *  is invisible to this app's mutation-invalidation machinery. */
const BINDING_POLL_MS = 3_000

function errMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** Never throws: `navigator.clipboard` is absent in jsdom and in any
 *  non-secure-context browser, and `writeText` can itself reject (permission
 *  denied) without that ever reaching the caller as an exception. Either way
 *  the command stays on screen, selectable by hand — this is best-effort
 *  convenience, not the only way to get the text out. Returns whether a copy
 *  was even attempted, so the caller can skip the success toast when it was not. */
function copyToClipboard(text: string): boolean {
  try {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (!clipboard || typeof clipboard.writeText !== 'function') return false
    void clipboard.writeText(text).catch(() => {})
    return true
  } catch {
    return false
  }
}

/** Human-readable "where this thread is publishing to" — all this component
 *  has is the numeric ids the bridge wrote, so that is what it names. */
function destinationLabel(binding: TelegramBinding): string {
  return binding.topicId ? `chat ${binding.chatId}, topik ${binding.topicId}` : `chat ${binding.chatId}`
}

/** Where the operator fixes an unready bridge — named exactly, since it is
 *  buried three levels deep in the settings dialog and "go set it up
 *  somewhere" is not actionable. */
const SETTINGS_PATH = 'Settings → Network → Telegram'

/** What to call the target when `machine` is null — the local process serving
 *  this page, which has no Machine record on a `--role hub`. Every other
 *  target is named outright, because an SSH thread runs on its connection's
 *  executor runtime (handler.CapSSHChat), routinely a different box from the
 *  one the operator is looking at. */
const LOCAL_MACHINE_LABEL = 'mesin yang menjalankan DevDeck ini'

function PublishDialog({
  open,
  onOpenChange,
  threadId,
  binding,
  readiness,
  machineName,
  project,
  onUnpublish,
  unpublishPending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  threadId: string
  /** `undefined` while unbound; once truthy the dialog switches to the
   *  confirmed state — including live, while the dialog is already open and
   *  polling just discovered the row. Takes priority over `readiness`: an
   *  existing binding was proven to work at publish time and stays
   *  visible/unpublishable even if the token was later removed. */
  binding: TelegramBinding | undefined
  /** Ignored once `binding` is set. Otherwise gates whether `/init` is
   *  offered at all — see `readinessOf`'s doc comment. */
  readiness: BridgeReadiness
  /** The machine whose bridge must be configured — NOT necessarily the one the
   *  operator is sitting at. An SSH thread runs on its connection's executor
   *  runtime (see handler.CapSSHChat), so "set the token in Settings" is
   *  actively misleading unless it names WHICH machine. */
  machineName: string
  /** The project this thread belongs to, when it has one. Present so the
   *  dialog can offer the whole-project alternative below — publishing one
   *  session at a time means re-running `/init` for every session created
   *  afterwards, and silently missing the ones you forget. `null` for a
   *  thread with no project (an SSH thread). */
  project: { id: string; name: string } | null
  onUnpublish: () => void
  unpublishPending: boolean
}) {
  const command = `/init ${threadId}`
  const projectCommand = project ? `/init ${project.id}` : null

  function copy() {
    if (copyToClipboard(command)) toast.success('Command copied')
  }

  function copyProject() {
    if (projectCommand && copyToClipboard(projectCommand)) toast.success('Command copied')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={380}>
      <DialogTitle>{binding ? 'Terpublish ke Telegram' : 'Publish ke Telegram'}</DialogTitle>

      {binding ? (
        <>
          <DialogDescription>Thread ini sedang dipublish ke {destinationLabel(binding)}.</DialogDescription>
          <p className="mt-3 font-mono text-[10.5px] text-devdeck-fg-2">
            Kirim <code>/unpublish</code> di chat Telegram tersebut, atau klik Unpublish di bawah, untuk berhenti.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="cursor-pointer rounded-md px-2.5 py-1.5 text-[12px] text-devdeck-fg-2 hover:text-devdeck-fg"
            >
              Tutup
            </button>
            <button
              type="button"
              onClick={onUnpublish}
              disabled={unpublishPending}
              className="cursor-pointer rounded-md px-2.5 py-1.5 text-[12px] font-medium text-devdeck-err disabled:cursor-not-allowed disabled:opacity-50"
            >
              Unpublish
            </button>
          </div>
        </>
      ) : readiness !== 'ready' ? (
        // No long-poll loop is running on the target process, so /init would
        // be sent into a void — do not show it. Name exactly where to fix
        // this: it is not discoverable from this dialog alone.
        <>
          <DialogDescription>
            {readiness === 'no-token'
              ? `Thread ini berjalan di mesin “${machineName}”, dan mesin itu belum punya bot token — jadi tidak ada proses yang mendengarkan pesan Telegram untuknya. Set token dulu di ${SETTINGS_PATH}, pada baris “${machineName}”. Tiap mesin butuh bot sendiri: Telegram hanya mengizinkan satu poller per token.`
              : `Thread ini berjalan di mesin “${machineName}”. Bridge di sana sudah punya token tapi masih dimatikan, jadi belum ada yang mendengarkan. Aktifkan di ${SETTINGS_PATH}, pada baris “${machineName}”.`}
          </DialogDescription>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="cursor-pointer rounded-md px-2.5 py-1.5 text-[12px] text-devdeck-fg-2 hover:text-devdeck-fg"
            >
              Tutup
            </button>
          </div>
        </>
      ) : (
        <>
          <DialogDescription>
            Kirim perintah ini di chat atau topik forum Telegram tujuan. Backend akan membaca chat dan topik dari
            pesan itu dan mempublish thread ini secara otomatis.
          </DialogDescription>
          <div className="relative mt-4 rounded-lg border border-devdeck-border-card bg-devdeck-pane p-2.5 pr-9">
            <pre className="select-all whitespace-pre-wrap break-all font-mono text-[12px] text-devdeck-fg">
              {command}
            </pre>
            <button
              type="button"
              onClick={copy}
              aria-label="Copy command"
              className="absolute right-2.5 top-2.5 cursor-pointer p-1 text-devdeck-fg-2 hover:text-devdeck-fg"
            >
              <Copy size={12} />
            </button>
          </div>
          <p className="mt-2 font-mono text-[10.5px] text-devdeck-fg-2">Menunggu pesan ini muncul di Telegram…</p>

          {/* The whole-project alternative. Offered here rather than hidden in
              a separate surface because this dialog is where an operator is
              already thinking about publishing, and the per-session route is
              the one that quietly goes stale: every session created after this
              one stays invisible until someone remembers to /init it too. */}
          {projectCommand ? (
            <div className="mt-4 border-t border-devdeck-border-card pt-3">
              <p className="text-[11px] text-devdeck-fg-2">
                Atau publish <strong className="text-devdeck-fg">seluruh project “{project?.name}”</strong> — pesan
                pertama di chat itu membuat sesi baru, dan sesi itu dipakai sampai <code>/new</code>. Bisa di DM
                atau grup; grup dengan Topics aktif bisa punya beberapa sesi sekaligus. Kirim ini di chat tujuan:
              </p>
              <div className="relative mt-2 rounded-lg border border-devdeck-border-card bg-devdeck-pane p-2.5 pr-9">
                <pre className="select-all whitespace-pre-wrap break-all font-mono text-[12px] text-devdeck-fg">
                  {projectCommand}
                </pre>
                <button
                  type="button"
                  onClick={copyProject}
                  aria-label="Copy project command"
                  className="absolute right-2.5 top-2.5 cursor-pointer p-1 text-devdeck-fg-2 hover:text-devdeck-fg"
                >
                  <Copy size={12} />
                </button>
              </div>
              {/* A project publish writes no binding for THIS thread, so the
                  "waiting…" line above will never resolve for it. Saying where
                  the confirmation actually appears stops that reading as a
                  hang. */}
              <p className="mt-2 font-mono text-[10.5px] text-devdeck-fg-2">
                Konfirmasinya muncul (dan di-pin) di Telegram, bukan di dialog ini.
              </p>
            </div>
          ) : null}
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="cursor-pointer rounded-md px-2.5 py-1.5 text-[12px] text-devdeck-fg-2 hover:text-devdeck-fg"
            >
              Batal
            </button>
          </div>
        </>
      )}
    </Dialog>
  )
}

/**
 * Rides the app's ambient `QueryClient` (`src/main.tsx` wraps the whole tree
 * in one), deliberately — NOT a private per-mount client. The binding list is
 * shared state: `useDeleteTelegramBinding` invalidates
 * `['telegram','bindings',machineId]`, and the bridge's own write (landed via
 * `/init`) is picked up by this component's own polling — but a private
 * cache would never see either, so publishing a thread from anywhere else
 * would leave this button still reading "Publish ke Telegram". Sharing the
 * cache also collapses the N headers on screen into one GET.
 *
 * A test that mounts this (directly or through `ChatHeader`) therefore needs
 * a `QueryClientProvider` of its own — see `AgentChatPane.test.tsx`.
 *
 * `machine` is a `TelegramTarget`, so `null` addresses the process serving
 * this page. A binding must be written to the process whose engine actually
 * holds the thread, and for a thread hosted by a `--role hub` that process
 * has no `Machine` record to name (see `TelegramTarget`'s doc comment).
 */
export function TelegramPublishButton({ machine, threadId }: { machine: TelegramTarget; threadId: string }) {
  // Which project this thread belongs to, so the dialog can offer publishing
  // the whole thing. Derived from the catalog the app already holds rather
  // than fetched: an extra chat pane is "<worktreeId>::chat-N" (server-side
  // NextChatSuffix), so the worktree id is the part before "::".
  const workspaces = useWorkspaces()
  const project = useMemo(() => {
    const worktreeId = threadId.split('::')[0]
    for (const ws of workspaces.data ?? []) {
      for (const p of ws.projects) {
        if (p.worktrees.some((w) => w.id === worktreeId)) return { id: p.id, name: p.name }
      }
    }
    return null
  }, [workspaces.data, threadId])
  const bindings = useTelegramBindings(machine, true)
  // Fetched unconditionally (not gated on the dialog being open, unlike
  // TelegramSection's `open`-gated fetch): the trigger button's own label
  // must already reflect readiness before the operator ever clicks it, or
  // "Publish ke Telegram" would flash before flipping to a blocked state.
  const config = useTelegramConfig(machine, true)
  const deleteBinding = useDeleteTelegramBinding(machine)
  const [dialogOpen, setDialogOpen] = useState(false)

  const binding = (bindings.data ?? []).find((b) => b.threadId === threadId)

  // Fails closed: a still-loading or errored config is treated the same as
  // "no token" rather than optimistically offering /init while we don't
  // actually know if the bridge can hear it.
  const readiness = readinessOf(config.data?.hasToken ?? false, config.data?.enabled ?? false)

  // A second observer on the SAME query key. It shares the cache entry the
  // line above reads, so a row this observer's own poll discovers is what
  // flips `binding` above truthy on the next render — which in turn flips
  // this call's own `enabled` to false, stopping the interval. Poll ONLY
  // while the dialog is open and this thread is still unbound; stop the
  // instant it is bound, and the instant the dialog closes. An always-on
  // poll here would be a regression — see BINDING_POLL_MS's doc comment and
  // TelegramSection's pairing-code block, which this mirrors.
  const pollBindings = dialogOpen && !binding
  useTelegramBindings(machine, pollBindings, pollBindings ? BINDING_POLL_MS : undefined)

  function unpublish() {
    deleteBinding.mutate(threadId, {
      onSuccess: () => {
        setDialogOpen(false)
        toast.success('Thread berhenti dipublish')
      },
      onError: (error) => toast.error(errMessage(error, 'Failed to unpublish from Telegram')),
    })
  }

  // Explicit loading/error states, not a silent fallthrough to the
  // unpublished label: `binding` is `undefined` both when this thread really
  // is unpublished AND when the list never arrived, and those must not look
  // the same. A header that says "Publish ke Telegram" for an already-bound
  // thread invites a second, contradictory publish, and a GET that 500s
  // would otherwise be swallowed with no trace anywhere in the UI.
  // `config` is gated here too, not just `bindings`. `readinessOf` fails
  // closed, so an unresolved config reads as `no-token` — correct as a default,
  // but rendering it while the request is still in flight would flash
  // "Telegram belum diatur" at an operator whose bridge is perfectly healthy,
  // and send them to Settings to fix a problem that does not exist. Same
  // defect as the one this block already guards against for `binding`: a
  // not-yet-known answer must never be painted as a known negative one.
  if (bindings.isLoading || config.isLoading) {
    return (
      <button
        type="button"
        disabled
        title="Memuat status Telegram…"
        className={cn(chatHeaderActionClassName, 'w-auto gap-1 px-1.5 text-[11px] disabled:cursor-default disabled:opacity-50')}
      >
        <Send size={12} aria-hidden="true" />
        Telegram…
      </button>
    )
  }

  if (bindings.error) {
    return (
      <button
        type="button"
        onClick={() => void bindings.refetch()}
        title={`${errMessage(bindings.error, 'Gagal memuat status Telegram')} — klik untuk coba lagi`}
        className={cn(
          chatHeaderActionClassName,
          'w-auto gap-1 px-1.5 text-[11px] text-devdeck-err hover:text-devdeck-err',
        )}
      >
        <Send size={12} aria-hidden="true" />
        Telegram gagal
      </button>
    )
  }

  // An existing binding wins over readiness unconditionally — see
  // `readinessOf`'s doc comment. Unbound, the label itself announces the
  // blocker so the operator does not have to open the dialog to learn
  // there is nothing to publish into yet.
  const label = binding
    ? 'Terpublish'
    : readiness === 'no-token'
      ? 'Telegram belum diatur'
      : readiness === 'disabled'
        ? 'Bridge Telegram nonaktif'
        : 'Publish ke Telegram'

  const title = binding
    ? 'Terpublish ke Telegram'
    : readiness === 'no-token'
      ? 'Belum ada bot token — atur dulu di Settings → Network → Telegram'
      : readiness === 'disabled'
        ? 'Bridge Telegram nonaktif — aktifkan di Settings → Network → Telegram'
        : 'Publish ke Telegram'

  return (
    <>
      {/* Icon-only until the header has room for words.
          
          The label used to render unconditionally on a `flex-none` button, so
          in the 300px SSH rail this one control held ~140px it would not give
          back: the thread badge collapsed to a single character and the status
          word clipped mid-word to "Id". The other header controls are all
          `size-6` icon buttons, and matching that vocabulary is what makes the
          row fit — the tooltip already carried the same sentence the label did.

          `@md` (28rem) is the width at which a full chat pane can spend the
          space and a rail cannot. Published state stays visible either way: it
          is the one state worth reading at a glance, and it is carried by the
          icon's colour (`--run`, a semantic status colour — not the accent,
          which DESIGN.md reserves for focus and primary actions). */}
      <button
        type="button"
        {...tourAnchor('chat-telegram')}
        onClick={() => setDialogOpen(true)}
        title={title}
        className={cn(
          chatHeaderActionClassName,
          '@md/chat-header:w-auto @md/chat-header:gap-1 @md/chat-header:px-1.5 @md/chat-header:text-[11px]',
          binding ? 'text-devdeck-run hover:text-devdeck-run' : undefined,
        )}
      >
        <Send size={12} aria-hidden="true" />
        {/* `sr-only`, not `hidden`: the button's accessible name stays the
            label at every width, so it never differs from the visible text
            when the text IS shown (WCAG 2.5.3, Label in Name). `title` carries
            the longer explanation as a tooltip, as it did before. */}
        <span className="sr-only @md/chat-header:not-sr-only">{label}</span>
      </button>
      <PublishDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        threadId={threadId}
        binding={binding}
        readiness={readiness}
        machineName={machine ? machine.name || machine.id : LOCAL_MACHINE_LABEL}
        project={project}
        onUnpublish={unpublish}
        unpublishPending={deleteBinding.isPending}
      />
    </>
  )
}
