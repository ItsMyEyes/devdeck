# Changelog

Notable changes per release. Each `## vX.Y.Z` section here becomes the body of
the matching GitHub Release — see `.github/workflows/release.yml`.

## v0.1.11

The largest release so far: a full editor replacement, a global command
palette, SSH port forwarding, host metrics, and a publishable SOCKS5 proxy.

### Editor — CodeMirror is gone, Monaco is in

- Every code surface now runs on Monaco: VS Code Dark+ theme, an optional
  VS Code keybinding mode remembered per browser, breadcrumbs, and a
  ref-counted model registry so the same file open in two panes stays in sync.
- Cross-file go-to-definition and find-references, with a fallback path when
  the language server can't answer.
- Cross-file rename: the edit is planned, previewed in a dialog, and applied
  across every affected file.
- Language servers get a `PATH` that can actually find their toolchain, and a
  dependency panel shows which servers and toolchains are present.
- JSON diagnostics and SQL completion.

### Global command palette

One keyboard-first palette over open tabs, workspace entities, bookmarks and
raw URLs, plus create-actions with drill-down pages. Results are ranked by a
frecency score that decays over time and prunes itself, and the input offers
ghost-text completion for the top hit.

### SSH

- **Quick add** — paste an `ssh` command and the connection form fills itself
  in, including the jump-host chain.
- **Port forwarding** — local, remote and dynamic (SOCKS5) forwards, with
  reconnect backoff, a rules panel, and full CRUD.
- **Right sidebar** — Port Forwarding and Stats panels, both kept mounted when
  you switch between them so neither loses its state.
- Open an SSH shell straight from the New tab screen, creating the host inline.
- Delete a connection.

### Host metrics

CPU, memory and disk for the local machine (`GET /api/system/stats`) and for
any SSH host, parsed from `/proc` and `df`. Rendered as a Stats pane with
sparklines and a disk bar. Unknown CPU samples are drawn as gaps rather than
charted as zero, and SSH transport failures surface as errors instead of
silently reading "unmeasurable".

### Published SOCKS5 proxy

Publish this process's SOCKS5 proxy from Settings, with an editable port and a
row for the machine itself. The config is persisted and replayed on boot, so a
published proxy comes back up with the process.

### Self-update

The running binary reports its own SHA-256, and the updater parses and
verifies the checksum manifest published with each release before replacing
anything on disk. The GitHub token is now optional.

### Terminals, explorer and chrome

- Per-tab shell sidebar with Explorer and Git panels; dragging a file over a
  folder auto-expands it.
- Live PTY session count, a terminal session registry, and a Terminal Sessions
  dialog in Machines for inspecting and killing sessions on a runtime.
- Browser tiles: a single centred omnibox with tiered URL rendering and a
  machine chip, back/forward driven by the webview's own history, and the
  native webview now shrinks under overlays instead of going blank.
- New elevation ladder (Palette A), quieter tab pills that pulse while
  loading, and an indeterminate progress line with a show-delay.

### Under the hood

- Frontend tests run on Vitest; the hand-rolled `check()` harness files are
  being migrated file by file.
- `NOTICE` acknowledges gopsutil (BSD-3-Clause).

### Not in this release: agent chat

The event-sourced agent-chat engine (`agentcore`), its `/ws/agent` socket, the
per-worktree thread store and the whole chat UI all ship in this build but are
**hidden** — the feature is still in flight, and shipping it half-finished
would be worse than shipping it late. Nothing in the UI can reach it: there is
no Sessions tab, and a new worktree opens a terminal as before.

To build with it visible:

```sh
VITE_AGENT_CHAT=1 npm run build
```

See `frontend/src/features/agent-chat/enabled.ts`.
