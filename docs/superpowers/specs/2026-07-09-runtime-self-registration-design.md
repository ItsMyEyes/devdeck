# Runtime Self-Registration — Design

**Date:** 2026-07-09
**Status:** Approved (brainstorming complete)

## Goal

Today, adding a `--role runtime` machine to a hub requires the operator to
manually open the Machines page and type its name, URL, and key. For the
solo-operator model this project is built for ("one operator, many
companies/machines"), that manual step is pure friction: the same operator
already holds every credential involved. This project lets a runtime
register itself with its hub automatically on startup, while leaving
`make dev` / `make dev-api` and any existing runtime deployment (one that
doesn't pass the new flags) completely unaffected.

This supersedes the "Runtime self-registration to the hub" bullet under
**Out of scope** in
`docs/superpowers/specs/2026-07-09-hub-runtime-tauri-design.md` — that
decision assumed a stricter trust boundary between hub and runtime
operators than actually applies here; see "Relationship to the original
design" below.

## Decisions (from brainstorming)

1. **Auth for the registration call:** reuse the hub's existing bearer-key
   auth (`--hub-key`, same value as the hub's own `--key`) rather than
   introducing a separate enrollment credential. No new hub-side auth
   concept; the runtime just calls the hub's machines API the same way a
   Tauri desktop client would.
2. **Trigger:** opt-in via the presence of a new `--hub-url` flag on a
   `--role runtime` process. Absent (the default), nothing changes —
   `make dev`, `make dev-api`, and every runtime deployment that predates
   this feature behave identically to before.
3. **Idempotency:** upsert by URL, implemented entirely client-side (on the
   runtime), reusing the hub's existing `GET`/`POST`/`PATCH /api/machines`
   endpoints. No new hub endpoint, no hub-side store/handler changes.
4. **Failure handling:** a failed registration attempt (hub not reachable
   yet, network not ready) is logged, never fatal — the runtime keeps
   serving normally regardless. A background loop retries on a fixed
   interval until one attempt succeeds, then stops; there is no ongoing
   heartbeat once registered (the hub's existing per-machine health check
   already covers liveness).
5. **Naming:** the machine's display name defaults to the OS hostname
   (`os.Hostname()`), overridable via `--name`.
6. **Public URL:** the runtime must be told the address other clients will
   use to reach it directly (`--public-url`), since a bind address like
   `--addr 127.0.0.1:9199` doesn't reveal the tailnet-reachable hostname.
   Defaults to `http://` + `--addr` when unset — adequate for same-host or
   already-tailscale-bound-address setups; the operator still types the
   real MagicDNS URL explicitly for anything else, exactly as they would
   when adding a machine by hand today.

## Relationship to the original design

The original spec's out-of-scope reasoning didn't spell out *why* it
excluded self-registration, but the natural reading is a stricter model
where hub and runtime operators might differ (self-registration would let
any process claiming to be a runtime add itself to the registry). This
project's actual trust model — confirmed in this session — is a single
operator running every machine themselves: they already possess the hub
key before they can start a runtime with `--hub-key` set, so
self-registration doesn't create a new discovery or trust boundary. It
automates a manual UI step using credentials the operator already has to
hand-deliver anyway.

## Architecture

**New `--role runtime` flags** (all optional; feature is off unless
`--hub-url` is set):

| Flag | Env | Default | Purpose |
|------|-----|---------|---------|
| `--hub-url` | `LOOM_HUB_URL` | `""` (disabled) | Hub base URL to self-register with. |
| `--hub-key` | `LOOM_HUB_KEY` | `""` | Hub's bearer key. Required if `--hub-url` is set (fails fast at startup). |
| `--public-url` | `LOOM_PUBLIC_URL` | `http://<--addr>` | This runtime's own reachable URL, advertised to the hub. |
| `--name` | `LOOM_MACHINE_NAME` | OS hostname | Display name in the hub's Machines UI. |

**Mechanism** — a new `machineclient.SelfRegister` function (package
`backend/internal/machineclient`, which already holds the hub→runtime
`FetchWorktrees` client; this is the inverse direction, runtime→hub):

1. `GET {hub-url}/api/machines` with `Authorization: Bearer {hub-key}`.
2. Scan the returned list for an entry whose `url` equals `--public-url`.
3. Found, and `name`/`key` already match → no-op (already correctly
   registered).
4. Found, but `name` or `key` differ → `PATCH {hub-url}/api/machines/{id}`
   with the corrected `name`/`key` (partial patch; `url` is left alone).
5. Not found → `POST {hub-url}/api/machines` with `{name, url, key}`.

A `machineclient.RunSelfRegisterLoop` wraps this in a retry loop: on error,
log and wait a fixed interval (30s) before trying again; on success, log
and return (stop retrying). `main.go` launches this as a background
goroutine, right after the listener starts, only when
`isRuntime && *hubURL != ""`. It never blocks or fails startup.

## Error handling

- `--hub-url` set without `--hub-key` → fatal at startup (same fail-fast
  style as the existing "`--role runtime` requires `--key`" check) — a
  registration attempt with no way to authenticate is a misconfiguration,
  not a silent no-op.
- Hub unreachable / non-200 response at any point in the loop → logged,
  retried after the interval; runtime keeps serving `/api/health`, git,
  worktrees, terminal, LSP throughout — self-registration status never
  gates the runtime's actual job.
- Hub reachable but returns a validation error (e.g. malformed `--public-
  url`, since the hub's `POST/PATCH /api/machines` already validates the
  URL shape) → logged and retried the same way; the operator will see the
  repeating log line and can fix the flag and restart.

## Known limitation (accepted, not solved now)

If the operator manually renames a self-registered machine's `url` via the
Machines UI afterward, the next runtime restart's URL-match will miss (no
entry has that runtime's `--public-url` anymore) and create a second row
instead of updating the renamed one. This is a rare, solo-operator-visible
edge case; not worth solving preemptively (YAGNI).

## Testing

- `machineclient.SelfRegister`: unit tests against an `httptest.Server`
  simulating the hub's machines API — covers create-when-absent,
  patch-when-different, no-op-when-already-correct, and error propagation
  on a non-200 response.
- `machineclient.RunSelfRegisterLoop`: unit test with a short retry
  interval, asserting it retries through initial failures and stops after
  the first success.
- `main.go` wiring: no unit test target (matches the existing pattern for
  this file); verified via `go build` + a manual two-process curl check —
  start a hub, start a runtime with `--hub-url`/`--hub-key` pointing at it,
  confirm `GET /api/machines` on the hub shows the runtime without any
  manual `POST`.

## Out of scope for this feature

- Any new hub-side endpoint or store/handler change — 100% additive on the
  runtime side, reusing `GET`/`POST`/`PATCH /api/machines` as they exist
  today.
- Automatic `--public-url` discovery (e.g. querying the `tailscale` CLI for
  a MagicDNS name) — the operator supplies the reachable URL explicitly,
  same as they would type it into the Machines UI by hand.
- Re-registration or a heartbeat after the first successful registration.
- Solving the "operator manually renamed the URL" edge case above.
