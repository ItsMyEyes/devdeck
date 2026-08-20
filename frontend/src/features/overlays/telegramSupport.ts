/**
 * Whether a machine's process can serve the Telegram bridge at all, and how
 * to say so when it cannot.
 *
 * This exists because of what an out-of-date runtime actually did. The bridge
 * is new, so a runtime older than it has no `/api/telegram/*` route; the
 * request falls through to the SPA's `index.html`, and the client tries to
 * `JSON.parse` an HTML document. The operator was shown
 *
 *     home-laptop        JSON Parse error: Unrecognized token '<'
 *
 * next to that machine's name — the parser's problem, not theirs. The real
 * answer ("this machine is on an older build; update it") was nowhere.
 *
 * The rule follows `sshChatAvailability.ts`, not `agentChatSupport.ts`, and
 * the asymmetry is deliberate: a capability list that is ABSENT is
 * conclusively "outdated" for a feature that shipped after capability
 * reporting did. (For a feature that predates it — worktree chat — the same
 * absence would wrongly condemn machines that work fine.)
 */
import type { Machine } from '@/store/types'

/** Must match `handler.CapTelegram` on the backend. */
export const TELEGRAM_CAPABILITY = 'telegram'

export type TelegramSupport =
  /** The machine advertises the capability; talk to it. */
  | 'supported'
  /** It answered, and its build has no Telegram bridge. Show "update this
   *  machine", never a transport error. */
  | 'outdated'
  /** The capability probe itself failed — the machine is unreachable, which
   *  is a different problem from an old build and gets different copy. */
  | 'unreachable'
  /** Still probing, or nothing to probe (the process serving this page). */
  | 'loading'

export interface TelegramSupportInput {
  /** The runtime this row targets, or `null` for the process serving this
   *  page — which is by definition new enough, since it rendered this UI. */
  machine: Machine | null
  /** `useMachineCapabilities` result: `undefined` while in flight, `null`
   *  when the machine reported no capability array, `string[]` when it did. */
  capabilities: string[] | null | undefined
  /** True once the capability probe has settled into an error. */
  capabilitiesFailed?: boolean
}

export function telegramSupport({
  machine,
  capabilities,
  capabilitiesFailed = false,
}: TelegramSupportInput): TelegramSupport {
  // The page's own process serves this component, so it serves the routes too.
  if (machine === null) return 'supported'
  // Checked BEFORE the undefined case: a failed probe also leaves
  // `capabilities` undefined, which is otherwise indistinguishable from
  // "still loading" and would spin forever.
  if (capabilitiesFailed) return 'unreachable'
  if (capabilities === undefined) return 'loading'
  // `null` is "answered, but reported no list" — a build older than
  // capability reporting, and therefore far older than this feature.
  if (capabilities === null || !capabilities.includes(TELEGRAM_CAPABILITY)) return 'outdated'
  return 'supported'
}

/** Operator-facing copy for a row that cannot be configured. `null` when the
 *  row is fine to render normally. */
export function telegramSupportMessage(support: TelegramSupport): string | null {
  switch (support) {
    case 'outdated':
      return 'build lama — belum punya bridge Telegram. Update mesin ini dulu.'
    case 'unreachable':
      return 'tidak bisa dihubungi'
    default:
      return null
  }
}
