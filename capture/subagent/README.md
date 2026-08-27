# Subagent live-capture evidence

Captured against the installed `claude` CLI — `claude --version` ==
**2.1.246 (Claude Code)**, authenticated, with network egress — using
`driver3.py`. Nothing here is inferred from documentation; every claim in
`docs/superpowers/specs/2026-08-26-subagent-observability-design.md` cites a
raw line in these files.

Two paths were substituted throughout (the ephemeral capture working
directory → `/home/user/project`, and `/Users/kiyora` → `/home/user`). No
lines were added, removed or reordered.

| File | What it shows |
|---|---|
| `driver3.py` | The harness: pipes a stream-json prompt into `claude`, reads until the terminal `result`. `FWD=1` adds `--forward-subagent-text`. |
| `capture-task2.ndjson` | One turn that spawns a subagent running three Bash calls, **without** the forwarding flag. |
| `capture-task3-forward.ndjson` | The same task **with** `--forward-subagent-text` — the reference capture. |

`backend/internal/agentcore/provider/claude/testdata/subagent.ndjson` is cut
directly from `capture-task3-forward.ndjson` (lines irrelevant to subagents
dropped; nothing added, edited or reordered).

## What the two captures prove

**The flag is the whole difference.** Without it only 7 frames carry a
`parent_tool_use_id` — the subagent's seed prompt, its 3 `tool_use` blocks and
their 3 `tool_result`s. Its **text and thinking are silently dropped**. With
it, 12 frames do, adding the narration. So a `Task`/`Agent` call on a CLI
started without the flag is a black box by construction, not by DevDeck's
choice.

## Findings that shaped the implementation

- **Attribution is `parent_tool_use_id`**, a top-level envelope field, and it
  is *three*-valued: absent on `system/*`, `result` and `rate_limit_event`;
  `null` for the parent conversation; the spawning call's id for a subagent.
  Absent and null must not collapse — hence `*string` on `wireLine`.
- **The spawn tool is named `Agent`**, though `system/init` advertises the
  string `Task` in its tools list. Matching only one misses every spawn.
- **`stream_event` never carries a non-null `parent_tool_use_id`** — 0 of 179
  frames across three captures. Subagent content arrives *only* as whole
  `assistant` frames, so a subagent transcript can never be token-streamed
  the way the parent's is. This inverts the parser's usual rule, where an
  `assistant` frame is ignored as a duplicate of what already streamed.
- **Forwarded `thinking` blocks are empty** — `{"type":"thinking",
  "thinking":"","signature":"…"}`. The envelope is forwarded, the reasoning
  is not; emitting a delta for it opens a reasoning row that never fills.
- **A spawn can be retracted.** After a `system/model_refusal_fallback`
  (`api_refusal_category: "cyber"`, opus-5 → opus-4-8) an `Agent` `tool_use`
  was emitted and then superseded — a later frame's `supersedes[]` carried its
  uuid and no `task_started` ever arrived for it. Treating the first
  `tool_use` as a live agent leaks a phantom that never starts or ends, which
  is why the parser waits for `task_started`. The fixture keeps this case.
- **`result.usage` excludes the subagent's tokens**; `result.subagent_stats`
  summarises the fleet, and the per-agent totals live on `task_progress` /
  `task_notification` / the `tool_use_result`.
- The on-disk transcript is a *different* representation: the subagent gets
  its own `…/<session_id>/subagents/agent-<task_id>.jsonl` with `isSidechain`
  and `parentUuid`, and **no** `parent_tool_use_id`. The two formats use
  different attribution keys; only the stream's is available to DevDeck.
