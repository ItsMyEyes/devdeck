# Copy-paste install command in the Add-runtime dialog

**Date:** 2026-07-26
**Status:** Approved
**Builds on:** [`2026-07-26-install-scripts-design.md`](2026-07-26-install-scripts-design.md)

## Problem

The Add-runtime dialog currently shows this (`MachineDialog.tsx:19-25`):

```
./devdeck.exe --role runtime --key <generated> --addr 0.0.0.0:9199 --db runtime.db --open=false \
  --hub-url <hub> --hub-key <your-hub-key> --public-url http://<hostname>:9199 --name <name>
```

It is labelled "Copy command", but it is not copy-pasteable. Three of its
values are angle-bracket placeholders the operator has to resolve by hand, and
it presumes a `devdeck` binary already exists on the target machine — which is
the actual hard part of adding a runtime, and the part the dialog does not
help with.

`scripts/install.sh` and `scripts/install.ps1` now do the whole job: download
the binary, install it, register with the hub, and verify the registration
landed. The dialog should hand the operator that one-liner instead.

## Goal

The operator picks the target machine's platform, pastes one line into a shell
there, and the machine appears in the Machines list. No manual editing of the
command, except secrets the browser genuinely cannot know.

## Non-goals

- **No change to the install scripts.** This work consumes them as they are.
- **No removal of the paste-connection-string path.** It stays as the fallback
  for machines provisioned by the setup wizard, or with no route to GitHub.
- **No service installation.** Inherited from the installer's non-goals.

## Design decisions and their costs

### The hub key comes from a new endpoint

The command needs `DEVDECK_HUB_KEY`, the hub's own bearer key. The browser
does not have it — the hub authenticates the SPA with a session cookie, and
the key lives only in the server process.

`handovertoken` does not solve this. It is machine-scoped (`Aud` is a single
machine id) and 60 seconds long, so it presupposes the machine already exists.
Registration is exactly the moment before that.

**Chosen: a new `GET /api/self/hub-key` endpoint returns the key to an
authenticated hub session.**

The cost, accepted knowingly: this makes a long-lived credential retrievable by
anything holding a hub session, and puts it into a clipboard and then into the
shell history of the target machine. A one-time registration token would avoid
that, at the price of a token store, a TTL, and a new verification path in
`PostMachine`. If that trade is revisited later, it can replace this endpoint
without changing the UI — the dialog only ever asks "what do I put in
`DEVDECK_HUB_KEY`".

Mitigations that are in scope:

- Registered only when `--role` is `hub` or `both`. A pure runtime has no hub
  key to hand out and must not serve the route at all.
- `Cache-Control: no-store` on the response.
- The key is never logged.

### `configured: false` is a first-class state

A hub started without `--key` cannot accept self-registration at all. The
endpoint reports `{"configured": false, "key": ""}` rather than an error, and
the dialog explains that the hub needs restarting with `--key` instead of
rendering a command that would fail on the target machine with a confusing
401.

### The GitHub token never reaches the server

`ItsMyEyes/devdeck` is private, so the installer needs `GITHUB_TOKEN`. The
dialog gets an optional password field for it, used **only** to compose the
displayed string — never sent in a request, never persisted, cleared when the
dialog closes. Left empty, the command still renders with a `<github-token>`
placeholder, which is honest about what the operator must supply.

### The hub URL stays client-side

`MachineDialog.tsx:80` already resolves it: the Tailscale-reported URL on a
loopback hub, otherwise `window.location.origin`. The endpoint deliberately
does not return a URL — two sources for one value would drift, and the client
already handles the Tailscale-not-ready case with dedicated guidance.

## Interface

### `GET /api/self/hub-key`

Hub and `both` roles only. Standard hub auth (session cookie or bearer key).

```json
{ "configured": true, "key": "a1b2c3…" }
```

```json
{ "configured": false, "key": "" }
```

Response carries `Cache-Control: no-store`. Errors use the standard
`{"error":"message"}` envelope (`CONTRACTS.md`).

A bearer-key caller can already present the hub key to reach this route, so
returning it grants no escalation. A cookie-session caller is the operator
themselves.

### `buildInstallCommand`

New pure module `frontend/src/features/machines/installCommand.ts`, alongside
the existing `connectionString.ts` and tested the same way.

```ts
export type InstallTarget = 'curl' | 'wget' | 'powershell'

export interface InstallCommandInput {
  target: InstallTarget
  hubUrl: string
  hubKey: string       // '' renders <your-hub-key>
  machineName: string  // '' renders <name>
  githubToken: string  // '' renders <github-token>
}

export function buildInstallCommand(input: InstallCommandInput): string
```

Output, with `\` line continuations for readability:

```bash
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | \
  GITHUB_TOKEN='ghp_xxx' \
  DEVDECK_HUB_URL='https://hub.tail-x.ts.net' \
  DEVDECK_HUB_KEY='a1b2c3' \
  DEVDECK_MACHINE_NAME='builder' sh
```

`wget` is identical with `wget -qO- <url> |`. PowerShell is:

```powershell
$env:GITHUB_TOKEN='ghp_xxx'; $env:DEVDECK_HUB_URL='https://hub.tail-x.ts.net'; $env:DEVDECK_HUB_KEY='a1b2c3'; $env:DEVDECK_MACHINE_NAME='builder'; irm https://kiyora.is-a.dev/devdeck/install.ps1 | iex
```

**Quoting is the part that can actually be wrong.** Machine names are free
text: `my box` splits into two arguments unquoted, and `o'brien` terminates a
single-quoted string early. Every interpolated value is quoted — POSIX single
quotes with `'\''` for embedded quotes, PowerShell single quotes with `''`
doubling. This is the primary thing the unit tests cover.

## UI

`MachineDialog.tsx` is already 270 lines, so the command block moves into its
own `RuntimeInstallCommand.tsx` rather than growing it further.

The add-mode (non-edit, non-paste) body becomes:

1. **Name** — unchanged.
2. **Target** — a three-way toggle, `curl` / `wget` / `PowerShell`, so the
   command matches what the target machine actually has. Defaults to `curl`.
3. **GitHub token** — optional, `type="password"`.
4. **Command block** — the built command, with the existing copy button.

Every state is explicit, per `.claude/rules/frontend.md`:

| State | Rendering |
|---|---|
| Hub key loading | "Loading hub key…" in place of the command |
| `configured: false` | The hub has no `--key`; restart it with one. No command shown — it could not work. |
| Query error | The command renders with the `<your-hub-key>` placeholder, plus the error. Degraded, not dead. |
| Tailscale not ready | Existing `tailscaleGuidance` block, unchanged — it already gates whether a usable hub URL exists. |

The hub-key query is enabled only while the dialog is open in add mode, so
opening the app does not fetch the key speculatively.

### Dead code removed

`generateRuntimeKey()` and the `runtimeKey` state go away. The installer
generates the runtime's own `DEVDECK_KEY` on the target machine and reports it
to the hub during self-registration, so a hub-side pre-generated key has no
consumer once the manual command is gone. Paste mode never used it.

## Testing

**Go** (`backend/internal/handler/hubkey_test.go`): key present returns
`configured: true` and the key; empty key returns `configured: false` and an
empty string; the response sets `Cache-Control: no-store`.

**Route registration**: a `--role runtime` process must not serve
`/api/self/hub-key`. Asserted where the other role-conditional route tests
live.

**TypeScript** (`installCommand.test.ts`): each of the three targets produces
the expected shape; each empty input falls back to its placeholder; a name
with a space and a name with an apostrophe are correctly quoted for both POSIX
and PowerShell.

**Gates**: `npm run typecheck`, `go vet ./...`, `go test ./...`.

## Open risk

The command points at `https://kiyora.is-a.dev/devdeck/install.sh`, which does
not resolve until the first `v*.*.*` tag is pushed — `deploy-docs.yml` only
runs on tags, and the repo currently has zero releases. Until then the dialog
renders a correct command against a URL that 404s. This is the same gap the
installer spec records; no additional mitigation is added here, because
mitigating it in two places would mean removing it in two places later.
