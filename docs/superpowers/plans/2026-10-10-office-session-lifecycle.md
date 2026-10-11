# Nama Karakter, Riwayat Sesi, dan Project → VM
Approved specification: user message in this task dated 2026-10-10.
Branch: codex/agent-workspace-3d. Base: 0dc80e5. Reuse isolated worktree.

## Task 1: Persistent backend metadata and session lifecycle
Generate and persist characterName once, backfill old threads, derive stable child names. Add archivedAt and archiving state via durable events, archive/resume commands, capabilities and DTOs. Archive cancels pending requests, stops an existing provider session, then confirms archival; errors keep the thread unarchived. Resume is metadata-only; turn/response commands reject archived/archiving sessions. Reconcile pending archive after restart without starting providers. Add parentProject to SSH CRUD/storage/catalog, preserving Group and credentials. Additive migrations and compatibility.
Tests first: metadata persistence/migration; lifecycle validation/replay/idempotency/failure/restart; SSH parent roundtrip/catalog; API isolation. Expected: relevant Go tests pass.

## Task 2: Names, history, controls, and Project → VM frontend
Wire optional DTO metadata and capabilities through modern/legacy overview. Name labels preserve chat title. Exclude archived from scene/roster/counts; one history drawer searches/filter division/project/host and opens read-only chats. Resume returns same session without turn. Archive/resume controls shared by AgentChatPane and SSH; normal Stop stays interrupt. Recognize archival across SessionsPanel and composer. Parent project free-text/suggestions in SSH dialog/list. Office deterministic grouping uses connection ID under parent project, not host IP. Preserve two floors/camera/20 slots/visibility/fallback.
Tests first: names, archive/restore/isolation, legacy disabled controls, grouped/filter/history/stability, SSH editor. Expected: frontend tests/typecheck/build pass.

## Task 3: Verification and desktop smoke
Run full frontend/backend/vet; use isolated fake-provider backend for archive/resume/no-provider-start/restart and desktop controls/20-avatar measurements. Production inspection remains read-only and does not upgrade installer/backend. Record device, FPS conditions, limits. Fresh reviewer whole change then one tested fix pass. Commit feature; no push/merge.
Expected: relevant checks pass, unrelated baseline failures explicitly recorded, evidence documented.

## Review Focus
Archive concurrency and errors, provider-stop acknowledgement vs request receipt, late provider events, restart pending archive, no provider start on history/resume, source ownership/SSH routing, migration/backfill durability and secrets, parent catalog replication, scene cap/group stability, legacy capability gating.
