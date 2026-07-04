# --enable-tailscale-serve

## Goal
One flag to expose Loom on the tailnet: `loom --enable-tailscale-serve` runs
`tailscale serve <port>` automatically instead of the operator running it in a
second terminal.

## Behavior
- New bool flag `--enable-tailscale-serve` (env `LOOM_TAILSCALE_SERVE`, default
  false) in `backend/cmd/server/main.go`, following the existing `envBool`
  pattern.
- After the TCP listener is bound, the port is taken from the actual listener
  address (`net.SplitHostPort`), so it is correct even with `--addr :0`.
- Loom spawns `tailscale serve <port>` as a foreground child process via
  `os/exec`, stdout/stderr wired to Loom's own. Foreground mode means the serve
  config lives only while the child runs — tailscale removes it on exit, no
  stale state in tailscaled.
- Ctrl-C on Loom reaches the child through the shared process group, so both
  shut down together.

## Error handling
- `tailscale` binary missing from PATH, or the child fails to spawn →
  `log.Fatalf` with a clear message (the operator explicitly asked for it).
- Child exits later on its own (e.g. tailscaled stopped) → `log.Printf` the
  exit error; Loom keeps serving locally.

## Out of scope
- `tailscale funnel` (public internet) — serve is tailnet-only by design.
- Frontend, store, or API changes — none.
