#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# e2e-smoke.sh — scripted smoke test for `make dev-tauri-full`'s real
# local-hub-mode desktop flow (sidecar spawn -> health check -> machine
# registration -> clean process teardown), without a human clicking through
# the native window.
#
# Builds a plain, non-watching debug binary (`tauri build --no-bundle
# --debug`) against a throwaway `dev.kiyora.devdeck.e2e` app identifier so it
# never collides with a developer's `dev-tauri-full` session or a real
# installed app, pre-seeds hub-mode.json so the one-time choose-hub-mode
# screen is skipped (that screen stays a manual, one-glance check via `make
# dev-tauri-full` — see COMMANDS.md), then launches the built app and
# observes the rest of the flow end to end.
#
# Scope: local hub mode only, macOS only. See
# docs/superpowers/specs/2026-07-17-tauri-desktop-e2e-smoke-harness-design.md
# for the full design and its explicit non-goals (no WebDriver, no remote-hub
# coverage, no CI wiring).
#
# Invoked via `make e2e-tauri-smoke`.
# -----------------------------------------------------------------------------

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "FAIL: this harness is macOS-only for now (see the design doc's Out of scope section)" >&2
  exit 1
fi

for bin in rustc npx curl pgrep; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "FAIL: required tool '$bin' not found on PATH" >&2
    exit 1
  fi
done

IDENTIFIER="dev.kiyora.devdeck.e2e"
APP_DATA_DIR="$HOME/Library/Application Support/$IDENTIFIER"
APP_LOG_DIR="$HOME/Library/Logs/$IDENTIFIER"
SIDECAR_LOG="$APP_LOG_DIR/sidecar.log"
MACHINE_ID_FILE="$APP_DATA_DIR/local-machine-id"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$(cd "$SRC_TAURI_DIR/.." && pwd)"
APP_BIN="$SRC_TAURI_DIR/target/debug/app"

# Mirrors READY_TIMEOUT_SECS in sidecar.rs — the same bound the Rust code
# itself uses for the listen line + health check.
READY_TIMEOUT_SECS=15
# How long to wait for clean process teardown after sending SIGTERM.
KILL_TIMEOUT_SECS=10

HOST_TRIPLE="$(rustc --print host-tuple)"
TOTAL_STEPS=8
STEP_NUM=0
APP_PID=""

step() {
  STEP_NUM=$((STEP_NUM + 1))
  printf '\n[%d/%d] %s\n' "$STEP_NUM" "$TOTAL_STEPS" "$1"
}

pass() {
  printf 'PASS: %s\n' "$1"
}

# Prints a FAIL line and exits non-zero. The EXIT trap (see below) always
# still runs, so a failed run never leaves the app (or its devdeck-server
# child) orphaned for the next run to collide with.
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

dump_log_tail() {
  local file="$1"
  if [[ -f "$file" ]]; then
    printf '  --- tail of %s ---\n' "$file" >&2
    tail -n 20 "$file" | sed 's/^/  | /' >&2
    printf '  ---------------------------------------------\n' >&2
  else
    printf '  (no such file: %s)\n' "$file" >&2
  fi
}

# Always attempt to kill the app process on exit (success, failure, or
# interrupt) so a failed run never leaves an orphaned `target/debug/app` (or
# its devdeck-server child, which the app's own SIGTERM handling — see
# kill_sidecar/install_signal_handlers in lib.rs — takes down with it).
cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$APP_PID" 2>/dev/null; then
      kill -9 "$APP_PID" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT INT TERM

# --- Step 1: reset app-data + app-log dirs for the e2e identifier -----------
step "Reset app-data/app-log dirs for $IDENTIFIER"
rm -rf "$APP_DATA_DIR" "$APP_LOG_DIR"
mkdir -p "$APP_DATA_DIR" "$APP_LOG_DIR"
pass "wiped and recreated $APP_DATA_DIR and $APP_LOG_DIR"

# --- Step 2: seed hub-mode.json so the choose-hub-mode screen is skipped ---
step "Seed hub-mode.json (mode=local)"
printf '{"mode":"local"}' > "$APP_DATA_DIR/hub-mode.json"
pass "wrote $APP_DATA_DIR/hub-mode.json"

# --- Step 3: tauri build --no-bundle --debug --config tauri.e2e.conf.json --
step "tauri build --no-bundle --debug --config tauri.e2e.conf.json"
if ! (cd "$FRONTEND_DIR" && npx tauri build --no-bundle --debug --config src-tauri/tauri.e2e.conf.json); then
  fail "tauri build failed (runs beforeBuildCommand: make sidecar-host) — see output above"
fi
if [[ ! -x "$APP_BIN" ]]; then
  fail "expected binary not found (or not executable) at $APP_BIN after build"
fi
pass "built $APP_BIN"

# --- Step 4: launch the app with the real hub-mode/sidecar flow enabled ----
step "Launch app (DEVDECK_TAURI_DEV_FULL=1)"
DEVDECK_TAURI_DEV_FULL=1 "$APP_BIN" >/dev/null 2>&1 &
APP_PID=$!
pass "launched pid $APP_PID"

# --- Step 5: poll sidecar.log for the listen line, parse the port ----------
step "Wait for sidecar listen line in sidecar.log"
PORT=""
DEADLINE=$((SECONDS + READY_TIMEOUT_SECS))
while (( SECONDS < DEADLINE )); do
  if [[ -f "$SIDECAR_LOG" ]]; then
    LINE="$(grep -F -m1 'devdeck listening on http://127.0.0.1:' "$SIDECAR_LOG" 2>/dev/null || true)"
    if [[ -n "$LINE" ]]; then
      CANDIDATE="$(printf '%s' "$LINE" | sed -E 's#^.*devdeck listening on http://127\.0\.0\.1:([0-9]+).*$#\1#')"
      if [[ "$CANDIDATE" =~ ^[0-9]+$ ]]; then
        PORT="$CANDIDATE"
        break
      fi
    fi
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    dump_log_tail "$SIDECAR_LOG"
    fail "app process exited before producing a listen line"
  fi
  sleep 0.25
done
if [[ -z "$PORT" ]]; then
  dump_log_tail "$SIDECAR_LOG"
  fail "no listen line appeared in $SIDECAR_LOG within ${READY_TIMEOUT_SECS}s"
fi
pass "sidecar listening on port $PORT"

# --- Step 6: poll GET /api/health until 200 --------------------------------
step "Poll GET http://127.0.0.1:$PORT/api/health"
HEALTHY=0
DEADLINE=$((SECONDS + READY_TIMEOUT_SECS))
while (( SECONDS < DEADLINE )); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
    HEALTHY=1
    break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    dump_log_tail "$SIDECAR_LOG"
    fail "app process exited while waiting for /api/health"
  fi
  sleep 0.25
done
if [[ "$HEALTHY" -ne 1 ]]; then
  dump_log_tail "$SIDECAR_LOG"
  fail "GET /api/health never returned 200 within ${READY_TIMEOUT_SECS}s"
fi
pass "GET /api/health returned 200"

# --- Step 7: poll local-machine-id until it matches ^m-[0-9a-f]+$ ----------
# (hubapi::upsert_local_machine only writes this file after a successful
# POST /api/machines — see hubapi.rs.)
step "Wait for local-machine-id matching ^m-[0-9a-f]+\$"
MACHINE_ID=""
DEADLINE=$((SECONDS + READY_TIMEOUT_SECS))
while (( SECONDS < DEADLINE )); do
  if [[ -f "$MACHINE_ID_FILE" ]]; then
    CONTENT="$(cat "$MACHINE_ID_FILE" 2>/dev/null || true)"
    if [[ "$CONTENT" =~ ^m-[0-9a-f]+$ ]]; then
      MACHINE_ID="$CONTENT"
      break
    fi
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    dump_log_tail "$SIDECAR_LOG"
    fail "app process exited before local-machine-id appeared"
  fi
  sleep 0.25
done
if [[ -z "$MACHINE_ID" ]]; then
  dump_log_tail "$SIDECAR_LOG"
  fail "no valid local-machine-id at $MACHINE_ID_FILE within ${READY_TIMEOUT_SECS}s"
fi
pass "local-machine-id = $MACHINE_ID"

# --- Step 8: kill the app; confirm the devdeck-server child also exits --------
step "Kill app; confirm devdeck-server-$HOST_TRIPLE child exits (no orphan)"
kill "$APP_PID" 2>/dev/null || true
APP_GONE=0
DEADLINE=$((SECONDS + KILL_TIMEOUT_SECS))
while (( SECONDS < DEADLINE )); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    APP_GONE=1
    break
  fi
  sleep 0.25
done
if [[ "$APP_GONE" -ne 1 ]]; then
  fail "app process $APP_PID did not exit within ${KILL_TIMEOUT_SECS}s of SIGTERM"
fi
CHILD_GONE=0
DEADLINE=$((SECONDS + KILL_TIMEOUT_SECS))
while (( SECONDS < DEADLINE )); do
  if ! pgrep -f "devdeck-server-$HOST_TRIPLE" >/dev/null 2>&1; then
    CHILD_GONE=1
    break
  fi
  sleep 0.25
done
if [[ "$CHILD_GONE" -ne 1 ]]; then
  fail "devdeck-server-$HOST_TRIPLE child process is still running ${KILL_TIMEOUT_SECS}s after the app exited (orphaned)"
fi
APP_PID=""
pass "app and its devdeck-server-$HOST_TRIPLE child both exited cleanly"

echo
echo "ALL STEPS PASSED"
exit 0
