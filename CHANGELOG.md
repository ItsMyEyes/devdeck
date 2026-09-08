# Changelog

Notable changes per release. Each `## vX.Y.Z` section here becomes the body of
the matching GitHub Release — see `.github/workflows/release.yml`.

## v0.2.4

**The Tools module no longer needs anything installed, machines wire
themselves up, and the app finally works on a phone.**

### Tools module: pure Go, nothing to install

The document-conversion pipeline used to shell out to a Python `markitdown`
venv, `pandoc`, and `mermaid-cli`, with a `--python-bin`/`--pandoc-bin`/
`--mmdc-bin` config block to point at each one. All of that is gone —
conversion now runs in-process in Go, so the Tools module works the moment
the binary starts, with nothing to install or configure.

### Automatic runtime binding

Adding a machine used to mean hand-configuring `--hub-url`/`--hub-key` on
that machine's runtime before it could talk back to the hub. The hub now
pushes its own URL and the machine's hub-assigned id to the runtime
automatically once it's registered — a runtime already started with an
explicit `--hub-url` is left alone.

### Bind address, LAN advertising, and account settings

New Settings controls: a bind-address picker (loopback / all interfaces /
a specific address) for the hub and runtime, and a real email/password
account for a locally-hosted hub in place of the placeholder
`operator@devdeck.desktop` — needed once the hub is reachable from more
than localhost. Alongside the picker, a runtime bound to `0.0.0.0` no
longer registers that unreachable address with the hub; it now advertises
its actual outbound-facing IP.

### Tailscale serve is now a live toggle

Serve used to be an all-or-nothing launch flag, and a desktop-shell
preflight race against Tailscale still starting at login could pin it
permanently to "disabled" until the next restart. It's now a runtime
toggle that can be flipped on or off without restarting. Fixed alongside
it: DevDeck's own serve mapping lives under the CLI's `Foreground.<id>.Web`
key, not the top-level `Web` the status check was reading, so DevDeck's own
serve state always reported "unknown" no matter how it was actually
configured.

### Mobile layout

The app has a mobile nav drawer, but nothing below the `md` breakpoint could
open it. A top bar with a menu button now makes it reachable on a phone,
and the sidebar gained a full labelled drawer mode to go with it.

### Also in this release

- A guided first-run tour, with a help button to replay it.
- In-page find and scoped select-all in the chat transcript and issue view
  — select-all in the transcript previously selected the entire app (tabs,
  sidebar, composer), not just the message text.
- Tab bodies now mount only when first activated instead of all at once on
  every workspace switch (a measured ~490ms main-thread block with four
  agent tabs open, gone).
- The file explorer now reveals and scrolls to the active file when a tab
  is opened or switched, VS Code-style.
- Stacked `AskUserQuestion` prompts get explicit Back/Next navigation
  instead of auto-advancing after 200ms with no way to revisit an earlier
  answer or confirm before the last question submitted the turn.
- Linux and Windows get their own Tauri window config and custom title-bar
  controls, instead of sharing the macOS config that assumed native
  traffic lights.
- A new in-browser compress tool, and the command palette now works on the
  web build, not just the desktop app.
- The Agents sidebar item was a no-op when clicked from an SSH shell tile;
  it now explicitly switches to the Agents tab.

## v0.2.3

**The desktop app can update itself, subagents are visible, and Full access
finally means full access.**

### Desktop auto-update

The About panel used to correctly report "a newer version is available" and
then offer no way to get it. It now checks on its own, downloads in the
background, and installs on an explicit click that names what the restart will
destroy. The release pipeline publishes a signed `latest.json` alongside the
`.dmg`/`.msi`/`.AppImage` for the updater to read.

### Subagent observability

Every CLI agent DevDeck drives can spawn subagents, and DevDeck modelled none
of them — a `Task`/`Agent` call that ran for ten minutes was ten minutes of a
motionless tool row. Subagent work is now attributed and streamed across all
four providers (claude, codex, opencode, pi).

Found while implementing this, and fixed here: `codex/adapter.go` handed the
parser only the `params` object, but the parser switches on the envelope's own
`method`. Every codex notification therefore arrived with an empty method and
came back as a warning — the **codex transcript was, in production, nothing
but warnings**: no assistant text, no tool calls, no turn lifecycle.

### Fixes

- **"Full access" was never reaching the agent.** Switching the Permission
  pill to Full access mid-session is refused outright by the claude CLI —
  `Cannot set permission mode to bypassPermissions because the session was not
  launched with --dangerously-skip-permissions` — and DevDeck never read the
  refusal, so the pill said one thing while every command kept raising an
  approval card. Sessions now launch with the unlock flag
  (`--allow-dangerously-skip-permissions`, which permits the switch without
  enabling bypass by default), and a refused control request is surfaced
  instead of dropped.
- **Leaving Plan mode silently discarded the thread's permission policy.**
  The interaction mode's two values double as the CLI's own permission-mode
  names, so exiting plan put the session in `default` — ask for everything —
  no matter what the pill read. The runtime mode is now re-asserted on the way
  out.
- **A dropped SFTP connection could never recover.** `fileOperationError`
  flattened its cause, so the pool's evict-and-redial check could never
  recognise a dead connection and kept handing the same dead client to every
  retry. The file tree collapsed to `read folder "" failed` with a Retry that
  could not work, while the terminal beside it — a separate SSH connection —
  carried on fine.
- **One failed refresh no longer wipes the file tree.** A listing that fails
  after a successful one keeps the last good listing on screen and shows the
  failure as a retry row above it, instead of replacing every expanded folder
  with an error screen.

### Also in this release

Keybindings are configurable from Settings; the editor gained auto-save and
external-change detection; the Telegram bridge got callback-deadline, card
retirement and mid-run publish fixes; multi-runtime machine handling and
per-turn session options were reworked.

## v0.2.1

**Agent chat is on.** v0.2.0 shipped the whole chat engine but hid it in
release builds behind a build-time flag, so the only way to reach it was to
compile your own with `VITE_AGENT_CHAT=1`. That gate is gone — deleted, not
defaulted — and the feature is simply part of the app now.

What that turns on:

- The **Sessions** tab in a worktree's shell sidebar, listing that worktree's
  threads.
- **New Chat** in a pane's "+" menu, alongside New Terminal and New File.
- Chat as the **default pane for a brand-new worktree**. Opening one now lands
  you in a chat rather than a terminal; the terminal is one split away. Every
  layout you have already arranged is persisted and keeps rendering exactly as
  it did — this only changes what a worktree you have never opened starts as.

SSH connections are unaffected: their DevOps Chat panel was already visible in
v0.2.0, and an SSH shell still opens as a shell.

`VITE_AGENT_CHAT` no longer does anything and has been removed from the env
declarations. Nothing else changed.

## v0.2.0

Remote operation. An agent that can actually drive an SSH host, a Telegram
bridge to the same threads from your phone, and a memory bank every runtime
shares. Three more CLI agents join `claude`.

### SSH DevOps chat

Every saved SSH connection now has a chat panel in its right rail, beside
Stats and Port Forwarding. The agent operates the host through DevDeck's own
API — never through an SSH client of its own — so any CLI agent with a shell
tool can drive it, and nothing about the capability set is per-provider.

- Runs on the connection's **executor runtime**, not the hub, so the agent
  lands where the connection's credentials already are.
- Reads remote files, runs diagnostics, and — behind an approval gate —
  changes things. The gate is ours, not a provider's, so the policy is
  identical on every runtime and is driven by the existing RuntimeMode pill.
  No new policy UI.
- Commands are classified before they run. A destructive one blocks on an
  approval card indistinguishable from a provider-raised one.
- The agent's only route to the host is `devdeck-ssh` — a subcommand of the
  one binary, shimmed into a per-thread workspace seeded with `AGENTS.md` and
  `SKILL.md`. Nothing extra to install or keep version-matched.
- Tool routes authenticate by thread token alone; the connection is derived
  from the token, never from the request.
- One thread per connection plus extra chats. History survives closing the
  tab and restarting the server.
- `@`-mention a remote file to insert its path; the agent reads the contents
  through a tool if it needs them.

### Telegram remote chat

Publish a thread to Telegram and drive it from your phone: the transcript
mirrored, working approval buttons, and `/model`, `/skills`, `/new`,
`/compact`. Enrolment is a short-lived pairing code, not a password.

One in-process long-poll loop per DevDeck process talks straight to that
process's engine — no extra service, no new dependencies. Publishing is
opt-in per thread. Settings › Network › Telegram.

### Persistent memory

A Hindsight-backed bank shared across every provider and runtime, configured
once on the hub.

- Settings › Memory picks the hosting: your own server or URL, a container
  (docker or podman), or bare metal (`uvx`, no Docker needed). DevDeck
  supervises the process either way — status, start, stop, logs — and never
  fails its own boot because the tool isn't installed.
- A **Memory** module in the sidebar: overview, browse, ask, graph,
  operations, and importing an existing brain.
- One bank, tagged by project, machine, provider and surface. Automatic
  recall is scoped to the thread's own project plus a global tier, so an
  unrelated project's facts don't bleed into a chat as noise.
- Agents reach it through the orchestration layer, so it behaves the same on
  every CLI instead of needing per-agent MCP wiring.

### Three more agent runtimes

`pi`, `codex` and `opencode` join `claude` in the provider registry. Each was
built against the live binary rather than its documentation — the published
wire shapes were wrong in every case. Approvals, tool calls and interrupts go
through the same engine for all four.

### Composer

The prompt input is a rich editor now.

- `@` mentions a file (local or remote), `/` runs a slash command, `$`
  inserts a skill.
- Image and file attachments, downscaled in the browser before upload.
- A draft per thread, plus a global prompt stash.
- A banner stack for pending approvals and pending user-input requests,
  answered inline instead of in a modal.
- An `ExitPlanMode` proposal renders as a plan card you can save to a file,
  and the composer becomes a follow-up prompt while the plan is on the table.

### AI inline completions (BYOK)

Ghost-text completions in the code editor from your own Anthropic or
OpenAI-compatible key. They're grounded against the file's live language
server — real completion candidates and document symbols go into the prompt,
and calls in the response are validated against the LSP before anything
renders. Three cache layers, Tab to accept. No key configured means the
feature silently does nothing. Settings › Completions.

### Notion-style markdown editor

Markdown files open in a block editor: slash menu, drag handles and block
controls, a selection toolbar, a document outline, frontmatter, live Mermaid
blocks, and markdown-aware paste.

### Documents

Images and video render inline. CSV and spreadsheet files get a real
scrollable grid instead of a flat dump.

### Fixes

- **Chat replay collapsed.** A streamed turn is durably logged one event per
  token, and every page load replayed all of them in a single WebSocket
  frame. One thread in the field was 274,851 events carrying 1.03 MB of text
  in 28.2 MB of payload. Replay now merges consecutive same-item deltas —
  938 events, ~1.1 MB, not one character lost. The durable log is untouched.
- **A render crash no longer white-screens the app.** A root error boundary
  catches it and logs the component stack, instead of leaving a blank page
  and a minified React error number.
- A lost-decision race in the approval gate: a resolve or cancel landing
  between opening and awaiting used to strand the waiter until its 10-minute
  ceiling — exactly what an interrupt during a pending approval did.
- Monaco gains a One Dark Pro Darker theme, JSON tokenisation, and
  range-scoped semantic tokens.
- README documents the macOS Gatekeeper bypass for the unsigned desktop app.

### Still hidden: the worktree agent-chat pane

The Sessions tab and the per-worktree chat pane remain off in shipped builds
— `agentChatEnabled()` returns false under `PROD`. The SSH DevOps chat panel
is **not** gated and ships visible; it's the first place this engine is
reachable in a release build.

To build with the worktree pane visible too:

```sh
VITE_AGENT_CHAT=1 npm run build
```

See `frontend/src/features/agent-chat/enabled.ts`.

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
