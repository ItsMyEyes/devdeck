/**
 * Explains a not-yet-working automatic binding (see
 * `backend/internal/service/bindingpush.go`) in the same terms
 * `TailscaleServeSection`'s `statusLabel` already uses for these reason
 * codes, so the two surfaces never disagree about what a code means.
 *
 * Pure and React-free so the decision can be tested directly, the same
 * shape as `sshChatAvailability.ts`.
 */
import type { MachineBindingStatus } from '@/lib/api'

/** Returns `null` when there's nothing to report — either still loading
 *  (`known` false) or the runtime is bound and synced.
 *
 *  `adopted` is checked BEFORE `hubReachable` on purpose: the backend keeps
 *  `adopted` sticky across a tick where the hub itself has no reachable URL
 *  or a push attempt didn't land (see `pushBindingsOnce`'s doc comment), so
 *  an already-synced runtime can report `adopted: true` together with
 *  `hubReachable: false` on a one-tick blip. Checking reachability first
 *  would turn that combination into a false "not reachable" alarm for a
 *  runtime that is, in fact, working fine. */
export function describeBindingIssue(status: MachineBindingStatus | undefined): string | null {
  if (!status?.known) return null
  if (status.adopted) return null
  if (!status.hubReachable) {
    switch (status.reason) {
      case 'not_installed':
        return "This hub has no address this runtime can reach yet — Tailscale CLI wasn't found on the hub."
      case 'not_ready':
        return "This hub has no address this runtime can reach yet — Tailscale isn't signed in on the hub."
      case 'serve_target_mismatch':
        return 'This hub has no address this runtime can reach yet — its tailscale serve points at a stale port.'
      default:
        return 'This hub has no address this runtime can reach yet — enable Tailscale serve from Settings › Network.'
    }
  }
  // Reachable, but not (yet, or ever) adopted: either a fresh refusal reason
  // from the runtime itself, or a push attempt that never landed there.
  return status.reason || 'This runtime has not accepted the connection from this hub yet.'
}
