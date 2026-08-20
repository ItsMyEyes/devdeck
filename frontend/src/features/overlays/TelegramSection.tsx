/**
 * Settings surface for ONE process's Telegram remote-chat bridge — one row
 * of `TelegramPublishSection`, which composes the self row plus one per
 * registered runtime exactly as `SocksPublishSection.tsx` does. This file
 * mirrors that section's visual language and TanStack Query usage
 * (loading/error/empty states, mutate-and-toast).
 *
 * `machine` is nullable for the reason `TelegramTarget` documents: the
 * process serving this page usually has no `Machine` record at all (a
 * `--role hub` never self-registers), and on a hub that process is the one
 * holding the `ssh:*` threads. `null` addresses it same-origin.
 *
 * `open` gates every fetch the same way it does on `SocksPublishSection`,
 * so the panel never pulls a bot token or the allowlist while its dialog
 * section is closed.
 */
import { Switch } from '@base-ui/react/switch'
import { TriangleAlert, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { StatusDot } from '@/components/ui/status-dot'
import { useMachineCapabilities, useMachines, useWhoami } from '@/features/data/queries'
import { telegramSupport, telegramSupportMessage } from './telegramSupport'
import {
  useCreatePairingCode,
  useDeleteTelegramUser,
  useSetTelegramConfig,
  useTelegramConfig,
  useTelegramUsers,
  type TelegramTarget,
} from '@/lib/telegramApi'
import { cn } from '@/lib/utils'
import type { Machine } from '@/store/types'

const switchRootClass = cn(
  'relative inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full bg-devdeck-card-wash transition-colors',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[checked]:bg-devdeck-run',
  'disabled:cursor-not-allowed disabled:opacity-50',
)

const switchThumbClass = cn(
  'pointer-events-none block h-3.5 w-3.5 translate-x-1 rounded-full bg-devdeck-fg-2 transition-transform duration-150',
  'data-[checked]:translate-x-[18px] data-[checked]:bg-devdeck-accent-ink',
)

const actionButtonClass = cn(
  'flex-none cursor-pointer rounded-md bg-devdeck-card-wash px-2.5 py-1 text-[11px] text-devdeck-fg-2',
  'hover:bg-devdeck-glass-solid hover:text-devdeck-fg',
  'disabled:cursor-not-allowed disabled:opacity-50',
)

const fieldLabelClass = 'w-16 flex-none text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2'

function errMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** How often the allowlist is re-read while a pairing code is on screen. */
const PAIRING_POLL_MS = 3_000

/** Seconds remaining until `expiresAtMs`, floored at 0. Ticks once a second
 *  while a pairing code is on screen so the operator can see it about to
 *  expire — the code itself is single-use server-side regardless.
 *
 *  `now` is re-read when the deadline changes, not only on the interval: the
 *  panel can sit mounted for many minutes before a code is issued, and a
 *  `now` frozen at mount time would show a wildly inflated first tick. */
function useCountdown(expiresAtMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (expiresAtMs === null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [expiresAtMs])
  if (expiresAtMs === null) return 0
  return Math.max(0, Math.round((expiresAtMs - now) / 1000))
}

/** The deadline to count down to, or `null` for "show the code, but do not
 *  run a clock on it".
 *
 *  A machine whose clock runs behind the browser's returns an `expiresAt`
 *  that is already in the past, and an unparseable one yields NaN. Both used
 *  to be fed straight into the countdown, which then read <= 0 (or NaN) and
 *  cleared the code off screen — hiding the one thing the operator opened
 *  this panel to read, for a code the server considers perfectly live. */
function countdownDeadline(expiresAt: string): number | null {
  const ms = Date.parse(expiresAt)
  return Number.isFinite(ms) && ms > Date.now() ? ms : null
}

/** How the RUNNING bridge's state renders. The `botUsername` beside a row's
 *  name is not evidence of anything — `getMe` succeeds against a token whose
 *  `getUpdates` is refused outright — so this is the only thing on the panel
 *  that answers "is it actually receiving messages?".
 *
 *  `undefined` means the backend predates the field; showing nothing is
 *  correct there, since an old build's silence is not a claim either way. */
const HEALTH_LABEL: Record<string, { text: string; color: string }> = {
  ok: { text: 'menerima pesan', color: 'var(--devdeck-run)' },
  connecting: { text: 'menyambung…', color: 'var(--devdeck-fg-2)' },
  error: { text: 'tidak menerima pesan', color: 'var(--devdeck-err)' },
  off: { text: 'mati', color: 'var(--devdeck-fg-2)' },
}

export function TelegramSection({
  machine,
  name,
  open,
}: {
  /** `null` = the process serving this page. See `TelegramTarget`. */
  machine: TelegramTarget
  /** Row heading — the machine's name, or `whoami.machineName` for the self
   *  row. Carried as a prop because the self row has no `Machine` to read it
   *  from, the same way `SocksPublishRow` takes `name`. */
  name: string
  open: boolean
}) {
  // Never seeded from `config.data`: the backend never serializes the real
  // token (see TelegramConfig.hasToken's doc comment), so there is nothing
  // to seed it WITH. An untouched field therefore always submits "", which
  // is exactly the "keep the stored one" signal PUT /telegram/config reads.
  const [tokenDraft, setTokenDraft] = useState('')
  const [pairing, setPairing] = useState<{ code: string; expiresAtMs: number | null } | null>(null)
  const secondsLeft = useCountdown(pairing?.expiresAtMs ?? null)

  // Asked BEFORE any /telegram call goes out. A runtime older than this
  // feature has no such route, so the request lands on the SPA's index.html
  // and the client reports "JSON Parse error: Unrecognized token '<'" — the
  // parser's problem, not the operator's. See telegramSupport.ts.
  const caps = useMachineCapabilities(machine ?? undefined)
  const support = telegramSupport({
    machine,
    capabilities: caps.data,
    capabilitiesFailed: caps.isError,
  })
  const unsupportedMessage = telegramSupportMessage(support)

  const config = useTelegramConfig(machine, open && support === 'supported')
  // Enrolment lands server-side, from Telegram — poll while a code is live so
  // the operator watches their account appear instead of staring at a stale
  // "No paired users yet". See useTelegramUsers' doc comment.
  const users = useTelegramUsers(machine, open, pairing ? PAIRING_POLL_MS : undefined)
  const setConfig = useSetTelegramConfig(machine)
  const pair = useCreatePairingCode(machine)
  const deleteUser = useDeleteTelegramUser(machine)

  useEffect(() => {
    if (pairing?.expiresAtMs != null && secondsLeft <= 0) setPairing(null)
  }, [pairing, secondsLeft])

  const enabled = config.data?.enabled ?? false
  const hasToken = config.data?.hasToken ?? false

  function submit(nextEnabled: boolean) {
    setConfig.mutate(
      // Trimmed, so a field holding nothing but whitespace reads as "keep the
      // stored one" too. The backend's only test for "unchanged" is `token
      // != ""`, so an untrimmed "   " would be written over a working bot
      // token and take the bridge down on the next restart. A real token has
      // no surrounding whitespace to lose.
      { enabled: nextEnabled, token: tokenDraft.trim() },
      {
        onSuccess: () => setTokenDraft(''),
        onError: (error) => toast.error(errMessage(error, 'Failed to save Telegram settings')),
      },
    )
  }

  function handlePair() {
    pair.mutate(undefined, {
      onSuccess: (result) => setPairing({ code: result.code, expiresAtMs: countdownDeadline(result.expiresAt) }),
      onError: (error) => toast.error(errMessage(error, 'Failed to create a pairing code')),
    })
  }

  return (
    // Just the panel: `TelegramPublishSection` owns the spacing between rows,
    // the same division of labour `SocksPublishRow` has with its section.
    <div className="rounded-lg border border-devdeck-border bg-devdeck-pane p-3.5">
      <div className="flex items-center justify-between gap-3">
        {/* Every accessible name below is scoped by `name`: several of these
            rows render at once, and an unscoped "Enable Telegram bridge"
            would name N different switches identically — ambiguous to a
            screen reader and to `getByLabelText`. Same reason
            `SocksPublishRow` interpolates its own `name`. */}
        <span className="min-w-0 truncate text-[12.5px] text-devdeck-fg">
          {name}
          {config.data?.botUsername ? (
            <span className="ml-2 font-mono text-[11px] text-devdeck-fg-2">@{config.data.botUsername}</span>
          ) : null}
        </span>
        {unsupportedMessage ? (
          // Never the raw transport error: an old build and an unreachable
          // machine are different problems with different fixes, and neither
          // of them is a JSON parse failure.
          <span className="font-mono text-[11px] text-devdeck-fg-2">{unsupportedMessage}</span>
        ) : support === 'loading' || config.isLoading ? (
          <span className="font-mono text-[11px] text-devdeck-fg-2">loading…</span>
        ) : config.error ? (
          <span className="font-mono text-[11px] text-devdeck-err">{errMessage(config.error, 'unreachable')}</span>
        ) : (
          <Switch.Root
            checked={enabled}
            onCheckedChange={(next) => submit(next)}
            disabled={setConfig.isPending}
            aria-label={`Enable Telegram bridge on ${name}`}
            className={switchRootClass}
          >
            <Switch.Thumb className={switchThumbClass} />
          </Switch.Root>
        )}
      </div>

      {config.data && !config.error ? (
        <div className="mt-3 flex flex-col gap-2.5">
          {/* The bridge's live state. Above the token field on purpose: when
              something is wrong, the reason is the first thing an operator
              needs, and the failure this replaces ("the bot just never
              answers") had no surface anywhere at all — not in the app, and
              not in Telegram either. */}
          {config.data.health && HEALTH_LABEL[config.data.health] ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <span className={fieldLabelClass}>Status</span>
                <span
                  className="inline-flex items-center gap-2 font-mono text-[11px]"
                  style={{ color: HEALTH_LABEL[config.data.health].color }}
                >
                  <StatusDot color={HEALTH_LABEL[config.data.health].color} size={6} />
                  {HEALTH_LABEL[config.data.health].text}
                </span>
              </div>
              {config.data.health === 'error' && config.data.healthDetail ? (
                <p className="ml-[76px] rounded-md border border-devdeck-red-tint bg-devdeck-red-tint/20 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-devdeck-fg">
                  {config.data.healthDetail}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <span className={fieldLabelClass}>Token</span>
              <Input
                type="password"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder={hasToken ? 'tersimpan' : 'Bot token dari @BotFather'}
                disabled={setConfig.isPending}
                aria-label={`Telegram bot token on ${name}`}
                className="h-7 flex-1 px-2 font-mono text-[11px]"
              />
              <button
                type="button"
                onClick={() => submit(enabled)}
                disabled={setConfig.isPending}
                aria-label={`Simpan Telegram token on ${name}`}
                className={actionButtonClass}
              >
                Simpan
              </button>
            </div>
            {hasToken ? (
              <p className="pl-[76px] font-mono text-[10.5px] text-devdeck-fg-2">tersimpan</p>
            ) : null}
          </div>

          {/* Compact, collapsed-by-default tutorial — this is a settings panel,
              not a docs page. Item 4 (privacy mode) is deliberately NOT list
              item 4: it is the failure mode operators actually hit ("prompt
              biasa" in a group silently never reaches the agent, no error
              anywhere), so it gets its own callout instead of being buried
              among the setup steps. */}
          <details className="rounded-md border border-devdeck-border-card bg-devdeck-pane/60 px-2.5 py-2 text-[10.5px] text-devdeck-fg-2">
            <summary className="cursor-pointer select-none font-semibold text-devdeck-fg-2 hover:text-devdeck-fg">
              Cara mendapatkan token
            </summary>
            <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-4">
              <li>
                Buka <strong className="text-devdeck-fg">@BotFather</strong> di Telegram dan kirim{' '}
                <code>/newbot</code>. Ikuti instruksinya untuk nama tampilan dan username yang harus diakhiri
                dengan <code>bot</code>.
              </li>
              <li>
                BotFather akan membalas dengan token berbentuk seperti{' '}
                <code className="break-all">123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw</code>. Tempel ke kolom
                token di atas, lalu aktifkan switch-nya.
              </li>
              <li>
                Untuk publish ke <strong className="text-devdeck-fg">topik grup</strong>: tambahkan bot ke grup,
                jadikan admin, dan aktifkan Topics di grup tersebut.
              </li>
            </ol>

            <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint/20 px-2.5 py-2">
              <TriangleAlert size={13} className="mt-0.5 flex-none text-devdeck-err" />
              <div className="text-devdeck-fg">
                <p className="font-semibold text-devdeck-err">Privacy mode bikin prompt biasa didiamkan</p>
                <p className="mt-1">
                  Secara default BotFather mengaktifkan <em>privacy mode</em>: bot di dalam grup hanya menerima
                  pesan yang diawali <code>/</code>, membalas bot, atau menyebut bot. Dengan privacy mode aktif,{' '}
                  <code>/init</code> dan command lain tetap jalan — tapi{' '}
                  <strong>prompt biasa yang diketik di grup tidak pernah sampai ke agent, tanpa error di mana
                  pun.</strong> Operator cuma melihat pesannya terkirim, lalu diam.
                </p>
                <p className="mt-1">
                  Perbaikannya: chat @BotFather, kirim <code>/setprivacy</code>, pilih bot ini, pilih{' '}
                  <strong>Disable</strong>, lalu keluarkan dan tambahkan lagi bot itu ke grup supaya perubahan
                  berlaku. DM satu-lawan-satu dengan bot tidak terpengaruh — privacy mode hanya berlaku di grup.
                </p>
              </div>
            </div>

            <p className="mt-2.5">
              Catatan: setiap proses DevDeck butuh bot dan token sendiri — <code>getUpdates</code> milik Telegram
              bersifat eksklusif per token. Memakai token yang sama untuk hub dan runtime membuat keduanya mati
              dengan <code>409 Conflict</code>.
            </p>
          </details>

          <div className="flex items-center gap-3">
            <span className={fieldLabelClass}>Pairing</span>
            {pairing ? (
              <span className="font-mono text-[13px] tracking-[0.2em] text-devdeck-fg">
                {pairing.code}{' '}
                {pairing.expiresAtMs !== null ? (
                  <span className="text-[10.5px] tracking-normal text-devdeck-fg-2">({secondsLeft}s)</span>
                ) : null}
              </span>
            ) : (
              <button
                type="button"
                onClick={handlePair}
                disabled={pair.isPending}
                aria-label={`Buat kode pairing on ${name}`}
                className={actionButtonClass}
              >
                Buat kode pairing
              </button>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <span className={fieldLabelClass}>Allowlist</span>
            {users.isLoading ? (
              <p className="font-mono text-[11px] text-devdeck-fg-2">loading…</p>
            ) : users.error ? (
              <p className="font-mono text-[11px] text-devdeck-err">{errMessage(users.error, 'Failed to load allowlist')}</p>
            ) : (users.data ?? []).length === 0 ? (
              <p className="font-mono text-[11px] text-devdeck-fg-2">No paired users yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {(users.data ?? []).map((u) => (
                  <li
                    key={u.userId}
                    className="flex items-center justify-between gap-2 rounded-md bg-devdeck-card-wash px-2 py-1"
                  >
                    <span className="min-w-0 truncate font-mono text-[11px] text-devdeck-fg">
                      {u.label || u.userId}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${u.label || u.userId} from ${name}`}
                      onClick={() =>
                        deleteUser.mutate(u.userId, {
                          onError: (error) => toast.error(errMessage(error, 'Failed to remove user')),
                        })
                      }
                      disabled={deleteUser.isPending}
                      className="flex flex-none cursor-pointer items-center justify-center rounded-md p-1 text-devdeck-fg-2 hover:bg-devdeck-glass-solid hover:text-devdeck-err disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Settings › Network › Telegram. One `TelegramSection` for the process
 * serving this page, then one per *other* registered runtime — the same
 * composition, and the same de-duplication by `whoami.machineId`, as
 * `SocksPublishSection`.
 *
 * The self row is not optional garnish. A `--role hub` never self-registers,
 * so without it the machine an operator is looking at — the desktop app's
 * default, and the one holding the `ssh:*` threads this feature was built
 * for — would be the one machine whose bot token could not be set at all.
 */
/**
 * Whether a registered machine IS the process serving this page, and so must
 * not get a second row of its own.
 *
 * Two signals, because neither alone is enough:
 *
 *  - `m.id === selfId` catches a runtime that self-registered. It is the only
 *    signal that works there, but it is useless on a hub: a `--role hub`
 *    never self-registers, so `whoami.machineId` is EMPTY and this comparison
 *    can never match.
 *  - `m.isLocal` catches exactly that hub case. A desktop hub registers
 *    itself as a local machine so worktrees can be assigned to it, so the
 *    machine list contains a row pointing straight back at this same process.
 *
 * Missing the second one is what produced two identical
 * "MacBook-Pro-kiyora.local @JunoyuBot" rows: the self row plus that local
 * machine record — one process, addressed two ways, each offering to
 * configure the same bot token.
 */
function isSelfMachine(m: Machine, selfId: string): boolean {
  if (selfId !== '' && m.id === selfId) return true
  return selfId === '' && m.isLocal
}

export function TelegramPublishSection({ open }: { open: boolean }) {
  const machines = useMachines(open)
  const whoami = useWhoami()

  const selfName = whoami.data?.machineName || 'This machine'
  // A runtime that HAS self-registered is in the list; drop it there so it
  // does not render twice. An empty machineId (a hub, or a runtime that has
  // not registered yet) must never match a real machine's id.
  const selfId = whoami.data?.machineId ?? ''
  const others = (machines.data ?? []).filter((m) => !isSelfMachine(m, selfId))

  return (
    <div className="flex flex-col gap-2.5">
      <TelegramSection machine={null} name={selfName} open={open} />

      {machines.isLoading ? (
        <p className="font-mono text-[11px] text-devdeck-fg-2">Loading machines…</p>
      ) : machines.error ? (
        <p className="font-mono text-[11px] text-devdeck-err">
          {errMessage(machines.error, 'Failed to load machines')}
        </p>
      ) : others.length === 0 ? (
        <p className="font-mono text-[11px] text-devdeck-fg-2">
          No other machines registered yet - add one to run a bot from it too.
        </p>
      ) : (
        others.map((m) => <TelegramSection key={m.id} machine={m} name={m.name} open={open} />)
      )}
    </div>
  )
}
