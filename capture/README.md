# T1 — Live-capture evidence (composer plan surface, subsystem B)

Everything in this directory was captured live against the installed
`claude` CLI — `claude --version` == **2.1.233 (Claude Code)**, authenticated,
with network egress — using the harness at `drive.py` (and two purpose-built
variants, `deny_exitplan.py` and `set_mode.py`, described below). Nothing here
is fabricated or inferred from documentation; every claim below cites a raw
`stdout.ndjson`/`log.txt` line.

This directory is the from-scratch recreation of the `capture/` evidence the
spec (`docs/superpowers/specs/2026-08-15-composer-plan-surface-design.md`)
cites throughout but which did not exist anywhere in this repository before
this task (see the plan's prerequisite section,
`docs/superpowers/plans/2026-08-15-composer-plan-surface.md:32-41`). Line
numbers the spec cites against `capture/m_stdio_plan/stdout.ndjson` and
`capture/e8_plan_nostdio` continue to resolve against the files here.

`backend/internal/agentcore/provider/claude/testdata/plan.ndjson` (T4's
fixture) is cut directly from `m_stdio_plan/stdout.ndjson`, with only two
strings substituted throughout (the ephemeral capture working directory →
`/home/user/project`, and `/Users/kiyora` → `/home/user`) — no lines added,
removed, or reordered. The ExitPlanMode `tool_use_id`
(`toolu_01UNeXLedXjsmJ25eWTgfoHr`) and every line offset the spec cites
(`design.md` "Correction" section: `content_block_start` at line 139, the
empty-`partial_json` delta at line 140, `content_block_stop` at line 143,
1-indexed) match exactly.

## Directory contents

| Path | What it shows |
|---|---|
| `drive.py` | The general-purpose harness: pipes a `stream-json` prompt into `claude`, answers `control_request`s per the `RESPOND` env var, logs every raw line. |
| `deny_exitplan.py` | Purpose-built variant for open question 1 below: allows every `can_use_tool` control_request except `ExitPlanMode`, which it denies with DevDeck's exact `planCapturedDenyMessage`. |
| `set_mode.py` | Purpose-built variant for open question 2 below: sends a `set_permission_mode` control_request on an already-running session past `system/init` and records the `control_response`. |
| `matrix.sh` / `matrix.out` | A sweep of every `--permission-mode` value, with and without `--permission-prompt-tool stdio` — the source of the `e8_plan_nostdio` vs. `m_stdio_plan` comparison the spec's "Where this sits" table cites. |
| `e8_plan_nostdio/` | `--permission-mode plan` **without** `--permission-prompt-tool stdio` (DevDeck's current `buildArgs`) — `ExitPlanMode` is absent from `system/init`'s `tools` list; the model searches for it three times (`ToolSearch`) and never finds it. |
| `m_stdio_plan/` | The same, **with** `--permission-prompt-tool stdio` (A's flag) — `ExitPlanMode` is present, gets called, and its `input.plan` appears on both the `assistant` tool_use line and the paired `control_request` line. Source of `testdata/plan.ndjson`. |
| `e3_deny/` | A generic `Write` denial (not plan-specific) — corroborates that denying a `can_use_tool` request in general still produces a terminal `result` line. |
| `deny_exitplan_verbatim/` | **Open question 1.** Denies the `ExitPlanMode` control_request with the verbatim message and records what follows. |
| `set_permission_mode_default_to_plan/`, `set_permission_mode_plan_to_default/` | **Open question 2.** Sends `set_permission_mode` on a live session in both directions. |
| `permission_mode_strings.txt` | A small excerpt from `strings $(which claude) \| grep -i permission_mode` (the full 47MB dump was not worth committing) — the three lines that reveal the wire shape used in `set_mode.py`. |

## Open question 1 — does denying `ExitPlanMode` still settle the turn?

**Verdict: yes.** Denying the `ExitPlanMode` `control_request` with the exact
verbatim message DevDeck's `parse.go` already sends
(`planCapturedDenyMessage`, `parse.go:296`:
*"The client captured your proposed plan. Stop here and wait for the user's
feedback or implementation request in a later turn."*) does **not** hang the
session. The CLI:

1. Delivers the denial to the model as a `tool_result` with `is_error:true`
   (`deny_exitplan_verbatim/stdout.ndjson` line 149, 1-indexed).
2. Runs one more turn where the model produces a text-only acknowledgement
   ("Plan is ready for review: ...", line 157) and stops with
   `stop_reason:"end_turn"`.
3. Emits a terminal `"type":"result"` line (line 161, the file's last line)
   **1.77s after the deny** — see `deny_exitplan_verbatim/log.txt`'s tail:
   `VERDICT: result line arrived 1.77s after the deny; 14 lines followed the
   deny in total`.

This matches the generic (non-plan-specific) `Write` denial in `e3_deny/`,
which also produced a `result` line after a similar one-turn acknowledgement.

**Consequence for T5:** the thread settles to idle on its own via the normal
`result` → terminal-event path. **No defensive idle-dispatch is required**
for the `event.TurnProposedCompleted` → `CmdThreadPlanPropose` case — unlike
`eventReducer.ts:300-302`'s belt-and-braces pattern for errors, this path
does not need one, because the CLI itself reliably closes the turn.

## Open question 2 — is `set_permission_mode` accepted on an already-running session?

**Verdict: yes, and it works exactly as the CLI's own embedded schema
describes.** The wire shape (from `permission_mode_strings.txt`, corroborated
live):

```json
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"set_permission_mode","mode":"<mode>"}}
```

(the CLI's schema also accepts an optional `"ultraplan"` boolean; not
applicable to DevDeck and omitted here.)

Sent past `system/init` on a live session with no pending turn, the CLI
answers **essentially synchronously** (0.00s in both directions, per each
run's `log.txt` `VERDICT` line):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<uuid>","response":{"mode":"<mode>"}}}
```

immediately followed by a `system`/`status` line confirming the live mode
switch:

```json
{"type":"system","subtype":"status","status":null,"permissionMode":"<mode>", ...}
```

Verified in **both directions**:
- `set_permission_mode_default_to_plan/stdout.ndjson`: session started with
  `--permission-prompt-tool stdio` only (mode `default`); switched live to
  `plan`. `system/status` echoes `"permissionMode":"plan"`.
- `set_permission_mode_plan_to_default/stdout.ndjson`: session started with
  `--permission-mode plan`; switched live to `default`. `system/status`
  echoes `"permissionMode":"default"`.

**Consequence for T5:** implement problem #2 via spec §4's path **(a)** —
`Reactor.react` gains an `EvtThreadInteractionModeSet` case that calls a new
`Adapter.SetInteractionMode`, which writes one `control_request` frame with
the shape above (mirroring `InterruptTurn`'s pattern,
`claude/adapter.go:410-419`). **The path (b) restart-with-resume fallback is
not needed** — do not implement it; `workers_reactor_test.go`'s new test
should assert the `SetInteractionMode` call, not a
`StopSession`/`Unbind`/`StartSession` sequence.

## Environment

- `claude --version` → `2.1.233 (Claude Code)`
- Authenticated (OAuth session; `"apiKeySource":"none"` in every `system/init`
  line here, not a bare API key)
- Network egress available
- All runs used `--safe-mode --model sonnet` for determinism/cost, except
  `m_stdio_plan`/`e8_plan_nostdio`, which predate that convention and instead
  pin `--model sonnet` where shown in each `log.txt`'s `ARGS:` line — the
  model choice does not affect wire shape, only response content.
