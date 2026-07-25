# YAML config + `devdeck setup` wizard

**Date:** 2026-07-25
**Status:** Approved design, ready for implementation planning

## Problem

Configuring a DevDeck machine today means assembling a command line out of 27
flags. Standing up a runtime is the worst case — `--role runtime --key … --addr
… --db … --open=false --hub-url … --hub-key … --public-url … --name …` — and
every value has to be right the first time, because a wrong `--hub-key` fails
silently 30 seconds later as a "Never synced with the hub" notice rather than an
error. There is no config file at all: `internal/config` only reads `.env`, and
the never-built `installer/` shell scripts from
`docs/superpowers/plans/2026-07-16-runtime-bootstrap-installer.md` were the only
plan to fix this.

## Goals

1. A single `devdeck.yaml` holds every setting, so a machine can be configured
   by editing one file instead of a command line.
2. `devdeck setup` — one interactive Bubble Tea wizard, step by step, that
   configures any deployment mode.
3. Running the binary with no config file auto-creates one.
4. The wizard ends by emitting the runtime's `name|url|key` connection line,
   both on stdout and in `copy-this.md`, ready to paste into the hub's
   **Machines → Add machine** dialog.

## Non-goals

- **OS service installation** (launchd / systemd / Scheduled Task). Explicitly
  out of scope; three OS paths plus uninstall and idempotency roughly double the
  surface.
- **Hub-side registration from the wizard.** Unnecessary — a runtime already
  self-registers on boot once `hub.url` and `hub.key` are set
  (`machineclient.RunSelfRegisterLoop`). The pasteable line is the fallback for
  when the operator would rather add it from the hub UI.
- **Config hot-reload.** Changes take effect on restart.
- **Frontend, Makefile, or Tauri sidecar changes.** All keep working unchanged
  via flags.

## Dependencies

Bubble Tea moved to v2 under a new module path. Target the current v2 line:

| Module | Version |
|---|---|
| `charm.land/bubbletea/v2` | v2.0.8 |
| `charm.land/bubbles/v2` | v2.1.1 |
| `charm.land/lipgloss/v2` | v2.0.5 |

The legacy `github.com/charmbracelet/bubbletea` path is frozen at v1.3.10 — do
not use it. These pull roughly ten transitive `charm.land/x/*` modules into a
currently lean `go.mod`; this is an accepted cost.

`gopkg.in/yaml.v3` is already an indirect dependency in `go.sum`; promote it to
direct. No other new dependency.

## Part 1 — Config file

### Schema

`internal/config` gains `config.go` with a `Config` struct mirroring today's
flags, grouped by concern:

```yaml
role: runtime            # hub | runtime | both
addr: 0.0.0.0:9199
db: data/devdeck.db
key: a1b2c3…             # this machine's API key
open: false

machine:
  name: builder
  public_url: https://builder.tail-abc.ts.net

hub:                     # runtime only — where to self-register
  url: https://hq.tail-abc.ts.net
  key: …

tailscale:
  serve: true

auth:
  two_fa: true
  secure_cookies: true
  turnstile:
    site_key: ""
    secret_key: ""

network:
  only_from: []
  trusted_proxies: []
  client_ip_header: ""

tools:
  python_bin: ""
  pandoc_bin: pandoc
  mmdc_bin: mmdc

proxy:
  socks5_addr: ""
  http_addr: ""
  key: ""

updates:
  github_token: ""
```

Every boolean field is `*bool`, so "key absent" stays distinguishable from
"explicitly false" — the same convention `internal/domain` patch structs already
use. List fields (`only_from`, `trusted_proxies`) are `[]string` in YAML and are
joined with `,` when handed to the existing comma-separated flag parsers.

### Strict parsing

Decode with `yaml.Decoder.KnownFields(true)`. An unknown key is a **hard error**
naming the key and its line number. A typo'd key that silently does nothing is
the worst failure mode for a config file — it looks configured and behaves as if
it were not.

### Lookup order

1. `--config <path>` flag, or `DEVDECK_CONFIG` env var
2. `./devdeck.yaml` (current working directory)
3. `<dir of executable>/devdeck.yaml` — matches the convention `defaultDBPath()`
   already uses for `data/devdeck.db`

First hit wins. A file named by `--config`/`DEVDECK_CONFIG` that does not exist
is an error; the implicit locations missing is not.

### Precedence: flag > env > YAML > built-in default

This falls out of the `flag` package for free. Load the YAML before declaring
flags, then feed its values in as each flag's default:

```go
// before
addr := flag.String("addr", envOr("DEVDECK_ADDR", "127.0.0.1:8989"), …)

// after
addr := flag.String("addr", envOr("DEVDECK_ADDR", pick(cfg.Addr, "127.0.0.1:8989")), …)
```

Two helpers — `pick(yamlValue, builtinDefault) string` and
`pickBool(*bool, bool) bool` — cover every case. When a flag is not passed, Go
leaves the default in place; when it is, it wins. Env still beats YAML because
`envOr` is evaluated outside `pick`.

`pick` treats an empty string as unset and falls through to the built-in
default, matching how `envOr` already treats an empty env var. `pickBool` keys
off `nil`, not off `false`, which is why the booleans are `*bool` — otherwise
`two_fa: false` would be indistinguishable from omitting the key and could never
turn 2FA off.

This is a one-line change per flag. Everything below `flag.Parse()` in the
815-line `cmd/server/main.go` is untouched, so the Tauri desktop sidecar,
`make dev-hub`, `make dev-runtime`, and every command in `TUTORIAL.md` keep
working with no edits.

Flag help text gains a pointer to the corresponding YAML key.

### Behaviour when no config file is found

- **Interactive** — stdin and stdout are both TTYs *and* `--managed` is not set:
  launch the setup wizard.
- **Non-interactive** — anything else (systemd, launchd, the Tauri sidecar, CI,
  piped output): write `<exe dir>/devdeck.yaml` containing the built-in defaults
  with explanatory comments, log `config: wrote <path> (defaults)`, and continue
  booting normally.

A headless service must never block on a prompt. This is why `--managed`
participates in the check: the desktop sidecar always sets it.

**The wizard always exits when it finishes; it never chains into starting the
server.** This holds whether it was reached by `devdeck setup` or auto-launched
by a missing config, so there is exactly one post-wizard behaviour to reason
about, and it is what the printed `Then start it: ./devdeck` line describes.

## Part 2 — Command surface

Inspect `os.Args[1]` before `flag.Parse()`. If it is `setup`, remove it from the
argument list and run the wizard instead of the server. Flags start with `-`, so
no existing invocation becomes ambiguous.

`devdeck setup` runs whether or not a config file already exists. When one does,
every step is pre-filled from it, which makes the same command the reconfigure
path. Without a TTY it exits non-zero with:

```
devdeck setup needs an interactive terminal; edit devdeck.yaml directly
```

## Part 3 — The wizard

New package `internal/setupui`:

| File | Responsibility |
|---|---|
| `wizard.go` | the `tea.Model`: Init/Update/View, step machine, navigation |
| `steps.go` | step definitions — prompt, kind, default, validation, role filter |
| `probe.go` | side effects as `tea.Cmd`: Tailscale detection, hub reachability, key generation |
| `write.go` | YAML and `copy-this.md` emission |

The step machine is a pure `next(state, input) → state` function, separable from
the terminal so it can be tested directly.

### Steps

| # | Step | Roles | Behaviour |
|---|---|---|---|
| 1 | Role | all | list select: hub / runtime / both — determines which later steps appear |
| 2 | Machine name | runtime, both | text, defaults to `os.Hostname()` |
| 3 | Listen address | all | defaults `127.0.0.1:8989` (hub) or `0.0.0.0:9199` (runtime/both) |
| 4 | Database path | all | defaults to `<exe dir>/data/devdeck.db` |
| 5 | API key | all | generates 32 random bytes via `crypto/rand`, displayed hex; `r` regenerates, field is editable. Required for runtime and both |
| 6 | Public URL | runtime, both | spinner while probing Tailscale; auto-fills `https://<dnsname>` on success, `http://<addr>` otherwise; editable |
| 7 | Tailscale serve | runtime, both | yes/no, pre-answered yes when step 6 found a tailnet |
| 8 | Hub URL + hub key | runtime | live check: `GET <hub>/api/whoami` with the bearer key, showing ✓ or the actual error; continue-anyway permitted |
| 9 | 2FA, secure cookies | hub, both | yes/no each |
| 10 | Review | all | renders the complete YAML for confirmation |

**Nothing is written to disk before step 10 is confirmed.** `ctrl+c` at any
point aborts leaving the filesystem untouched.

Navigation: `enter` advances, `shift+tab` / `esc` goes back, `ctrl+c` aborts.
Validation runs on advance and blocks with an inline message — an unparseable
listen address or an empty key for a runtime cannot be skipped past.

### Tailscale detection

Step 6 reuses `detect.ResolveTailscale`, which already handles `PATH`, the macOS
app bundle, and the common install directories. The JSON parsing of
`tailscale status --self --json` currently lives unexported in
`internal/handler/tailscale_status.go` as `tailscaleSelfURL`. Move it into
`internal/detect` so the handler and the wizard share one implementation rather
than growing a second copy — a targeted improvement to code this feature
touches, not speculative refactoring.

`probe.go` reaches Tailscale and the hub through small interfaces so both can be
faked in tests, mirroring the existing overridable `var resolveTailscale`
pattern in `tailscale_status.go`.

## Part 4 — Output

The final screen is printed to stdout **after** the Bubble Tea program exits, so
it survives the alternate screen buffer and remains pipeable and copy-pasteable.

For `role: runtime` and `role: both`:

```
✓ devdeck.yaml     /opt/devdeck/devdeck.yaml
✓ copy-this.md     /opt/devdeck/copy-this.md

Paste this line into the hub → Machines → Add machine → "Have a connection string instead?"

  builder|https://builder.tail-abc.ts.net|a1b2c3d4…

Then start it:  ./devdeck
```

For `role: hub` the connection line and `copy-this.md` are omitted; the summary
ends at the written config path and the start command.

`copy-this.md` is written next to `devdeck.yaml` and wraps the same single line
in instructions. The line is exactly three non-empty `|`-separated fields —
`name`, `public_url`, `key` — which is what
`frontend/src/features/machines/connectionString.ts` parses. Regenerating it is
just re-running `devdeck setup`.

## Part 5 — Secret handling

`devdeck.yaml` and `copy-this.md` both contain live API keys. Both are written
with mode `0600`, and both are added to `.gitignore`.

While designing this, two secrets were found in the repository and `.gitignore`
was found to contain only `/dist/` and `.DS_Store`:

- **`backend/auth.key` is already committed** — `git ls-files` lists it, so it
  is in history, not merely staged. `loadOrCreateAuthKey` treats this file as
  the 32-byte key that signs every session cookie.
- **`backend/signing.key` is staged** (`git status` reports `A`), not yet
  committed.

This is a pre-existing leak unrelated to the feature, but it is the same gap the
feature widens, so it is in scope:

- Extend `.gitignore` with `*.key`, `devdeck.yaml`, `copy-this.md`, `*.db`,
  `*.db-shm`, `*.db-wal`. No `.db` files are currently tracked, so that pattern
  is clean; the two `.key` files are not, which is why the next step is needed.
- `git rm --cached backend/auth.key backend/signing.key` — `.gitignore` alone
  does not untrack an already-tracked file.
- **Rotate `auth.key`.** Because it is in history, the committed value must be
  treated as compromised. Deleting the local file is the whole rotation:
  `loadOrCreateAuthKey` mints a fresh 32-byte key and writes it back at `0600`
  on next start. The only consequence is that existing sessions stop validating
  and everyone signs in again.

Purging the value from git history (filter-repo / BFG) is a rewrite affecting
every clone and is left to the operator's judgment; rotation is what actually
neutralizes the exposure.

## Testing

**`internal/config`**
- Precedence table test: every combination of built-in default / YAML / env /
  flag resolves to the expected value
- Missing config file at each of the three lookup locations
- `--config` pointing at a nonexistent path errors
- Malformed YAML reports a useful message
- Unknown key errors, naming key and line
- Write-then-read round-trip preserves every field, including `*bool` tri-state
- Generated defaults file parses back cleanly

**`internal/setupui`**
- Step-machine transitions for each of the three roles, driven directly with no
  terminal — asserting which steps appear and which are skipped
- Validation rejects: bad listen address, empty key for runtime, malformed hub
  URL
- Back-navigation preserves already-entered values
- Golden test on the rendered review screen
- `probe.go` with faked Tailscale (found / not installed / not on a tailnet) and
  faked hub check (reachable / wrong key / unreachable)
- `write.go`: emitted `copy-this.md` line splits into exactly three non-empty
  fields; file modes are `0600`

**Existing suites** must pass unchanged — that is the proof the flag path did
not regress. `go vet ./...` before committing, per `.claude/rules/go.md`.

## Documentation

- `TUTORIAL.md` §13 leads with `devdeck setup`; the flag-based commands stay,
  documented as overrides
- `README.md` quickstart points at `devdeck setup`
- `COMMANDS.md` gains the `setup` subcommand
- A commented `devdeck.yaml.example` at the repo root

## Risks

- **Bubble Tea v2 is a recent major version.** Its API differs from the v1
  examples that dominate search results; work from the v2 upgrade guide and the
  `charm.land/*` import paths, not from memory.
- **Dependency growth.** ~10 new transitive modules in a deliberately lean
  `go.mod`. Accepted.
- **Precedence regressions.** The one-line-per-flag change is mechanical but
  touches all 27 flags. The precedence table test is the guard; existing suites
  passing unchanged is the second.
