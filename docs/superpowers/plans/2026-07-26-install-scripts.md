# One-Line Installer Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `scripts/install.sh`, `scripts/install.ps1`, and `scripts/install.cmd` so a single piped command installs the DevDeck binary on Linux/macOS/Windows and can register the machine as a runtime against an existing hub.

**Architecture:** Each script runs the same pipeline — detect platform, resolve the release asset id from the GitHub API, download it with a token (the repo is private), verify its SHA-256, install it to a per-user directory, and optionally write a config file, start the runtime detached, and confirm it registered with the hub. All pure helpers in `install.sh` are sourced and unit-tested by `scripts/test/install_test.sh`; network paths are verified manually.

**Tech Stack:** POSIX `sh` (dash/ash/bash/zsh), PowerShell 5.1+, cmd.exe batch, Go 1.25 (`backend/internal/selfupdate`), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-26-install-scripts-design.md` — read it before starting.

## Global Constraints

- `install.sh` is **POSIX `sh` only**. No bashisms: no `[[ ]]`, no arrays, no `local`, no `+=`, no `$'...'`, no `function` keyword. It must pass `shellcheck -s sh` clean.
- `install.sh` must call `set -eu` **inside `main()`**, never at file scope — the test harness sources the file and would inherit it.
- The entire executable body lives in `main()`, invoked on the final line guarded by `if [ "${DEVDECK_INSTALL_TEST:-0}" != "1" ]`. A truncated download must execute nothing.
- `install.ps1` targets **PowerShell 5.1** (the Windows built-in). No PowerShell 7-only syntax: no `??`, no ternary `? :`, no `-Parallel`.
- Release asset names are exactly `devdeck-runtime-<goos>-<goarch>`, with a `.exe` suffix only on Windows. Six combinations: `darwin-amd64`, `darwin-arm64`, `linux-amd64`, `linux-arm64`, `windows-amd64`, `windows-arm64`.
- Repository is `ItsMyEyes/devdeck` (owner `ItsMyEyes`, repo `devdeck`) and it is **private** — every GitHub API call carries `Authorization: Bearer <token>`.
- Asset downloads use `GET /repos/<owner>/<repo>/releases/assets/<id>` with `Accept: application/octet-stream`. Never `browser_download_url`.
- Environment variable names must match the ones `backend/cmd/server/main.go:43-71` already reads: `DEVDECK_ROLE`, `DEVDECK_KEY`, `DEVDECK_ADDR`, `DEVDECK_HUB_URL`, `DEVDECK_HUB_KEY`, `DEVDECK_PUBLIC_URL`, `DEVDECK_MACHINE_NAME`.
- Default install dir is `~/.local/bin` (Unix) / `%LOCALAPPDATA%\DevDeck\bin` (Windows), overridable with `DEVDECK_INSTALL_DIR`. **Never** invoke `sudo` or request elevation.
- Go code follows `.claude/rules/go.md`: `log.Printf`/`log.Fatalf`, run `go vet ./...` before committing.
- Do not edit any file listed as a convergence file in `CLAUDE.md` (`routeTree.gen.ts`, the two store/type files, `models.go`, `main.go`, `port/store.go`). This plan touches none of them.

---

### Task 1: Fix `selfupdate` asset name and repo constant

The shipped `--updates` flag cannot work today: `AssetName` builds `devdeck-<os>-<arch>` while CI publishes `devdeck-runtime-<os>-<arch>`, and `Repo` still names the old `enginer-workspaces` repository. The installer targets the published names, so these must agree.

**Files:**
- Modify: `backend/internal/selfupdate/asset.go:5-13`
- Modify: `backend/internal/selfupdate/run.go:14`
- Test: `backend/internal/selfupdate/asset_test.go:5-21`

**Interfaces:**
- Consumes: nothing.
- Produces: `selfupdate.AssetName(goos, goarch string) string` returning `devdeck-runtime-<goos>-<goarch>[.exe]`. Task 2's `asset_name()` shell function must return byte-identical strings for the same inputs.

- [ ] **Step 1: Update the failing test**

Replace the `tests` table in `TestAssetName` (`backend/internal/selfupdate/asset_test.go`) so every expectation carries the `-runtime` infix:

```go
func TestAssetName(t *testing.T) {
	tests := []struct {
		goos, goarch, want string
	}{
		{goos: "darwin", goarch: "amd64", want: "devdeck-runtime-darwin-amd64"},
		{goos: "darwin", goarch: "arm64", want: "devdeck-runtime-darwin-arm64"},
		{goos: "linux", goarch: "amd64", want: "devdeck-runtime-linux-amd64"},
		{goos: "linux", goarch: "arm64", want: "devdeck-runtime-linux-arm64"},
		{goos: "windows", goarch: "amd64", want: "devdeck-runtime-windows-amd64.exe"},
		{goos: "windows", goarch: "arm64", want: "devdeck-runtime-windows-arm64.exe"},
	}
	for _, tt := range tests {
		if got := AssetName(tt.goos, tt.goarch); got != tt.want {
			t.Errorf("AssetName(%q, %q) = %q, want %q", tt.goos, tt.goarch, got, tt.want)
		}
	}
}
```

Then update `TestPickAsset`'s fixture names in the same file so they match what a real release contains:

```go
	assets := []Asset{
		{Name: "devdeck-runtime-darwin-amd64", ID: 1},
		{Name: "devdeck-runtime-linux-amd64", ID: 2},
	}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/selfupdate/ -run 'TestAssetName|TestPickAsset' -v`
Expected: FAIL — `AssetName("darwin", "amd64") = "devdeck-darwin-amd64", want "devdeck-runtime-darwin-amd64"`.

- [ ] **Step 3: Write the minimal implementation**

In `backend/internal/selfupdate/asset.go`, change the format string and update the comment to name the CI step that owns the naming:

```go
// AssetName returns the release asset filename for a platform, matching the
// names .github/workflows/release.yml publishes — `make portable-all` builds
// `devdeck-<os>-<arch>` and the release job renames them with a `-runtime`
// infix to distinguish server binaries from the `-desktop` Tauri bundles.
func AssetName(goos, goarch string) string {
	name := fmt.Sprintf("devdeck-runtime-%s-%s", goos, goarch)
	if goos == "windows" {
		name += ".exe"
	}
	return name
}
```

In `backend/internal/selfupdate/run.go`, fix the repository name:

```go
const (
	Owner = "ItsMyEyes"
	Repo  = "devdeck"
)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/selfupdate/... && go vet ./...`
Expected: PASS, no vet output.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/selfupdate/asset.go backend/internal/selfupdate/run.go backend/internal/selfupdate/asset_test.go
git commit -m "fix(selfupdate): target the published asset names and the devdeck repo

AssetName built devdeck-<os>-<arch> while release.yml publishes
devdeck-runtime-<os>-<arch>, so PickAsset could never match a real
release asset. Repo also still named the pre-rename enginer-workspaces
repository, pointing the API call at a repo that does not exist."
```

---

### Task 2: `install.sh` skeleton, platform detection, and test harness

**Files:**
- Create: `scripts/install.sh`
- Create: `scripts/test/install_test.sh`

**Interfaces:**
- Consumes: `AssetName` naming from Task 1 (string equality only, no code dependency).
- Produces, for Tasks 3–5:
  - `normalize_os <uname-s>` → prints `darwin`|`linux`, exit 1 otherwise
  - `normalize_arch <uname-m> [translated]` → prints `amd64`|`arm64`, exit 1 otherwise
  - `asset_name <os> <arch>` → prints the release asset filename
  - `port_of <host:port>` → prints the port
  - `die <message>` → prints `devdeck: <message>` to stderr, exits 1
  - `info <message>` / `warn <message>` → stderr logging
  - `main()` — the entry point every later task appends to
  - Globals: `OWNER`, `REPO`, `API`, `BIN_NAME`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/install_test.sh`:

```sh
#!/bin/sh
# Unit tests for the pure helpers in scripts/install.sh.
#
# install.sh guards its `main "$@"` call on DEVDECK_INSTALL_TEST, so sourcing
# it here defines every function without running an install.
#
# Run: sh scripts/test/install_test.sh

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEVDECK_INSTALL_TEST=1
export DEVDECK_INSTALL_TEST
# shellcheck source=../install.sh
. "$SCRIPT_DIR/install.sh"

PASSED=0
FAILED=0

assert_eq() {
	if [ "$2" = "$3" ]; then
		PASSED=$((PASSED + 1))
	else
		FAILED=$((FAILED + 1))
		printf 'FAIL: %s\n  got:  %s\n  want: %s\n' "$1" "$2" "$3" >&2
	fi
}

assert_fails() {
	desc="$1"
	shift
	if "$@" >/dev/null 2>&1; then
		FAILED=$((FAILED + 1))
		printf 'FAIL: %s (expected a non-zero exit)\n' "$desc" >&2
	else
		PASSED=$((PASSED + 1))
	fi
}

# ── normalize_os ─────────────────────────────────────────────
assert_eq "normalize_os Darwin" "$(normalize_os Darwin)" "darwin"
assert_eq "normalize_os Linux" "$(normalize_os Linux)" "linux"
assert_fails "normalize_os rejects FreeBSD" normalize_os FreeBSD
assert_fails "normalize_os rejects empty" normalize_os ""

# ── normalize_arch ───────────────────────────────────────────
assert_eq "normalize_arch x86_64" "$(normalize_arch x86_64 0)" "amd64"
assert_eq "normalize_arch amd64" "$(normalize_arch amd64 0)" "amd64"
assert_eq "normalize_arch arm64" "$(normalize_arch arm64 0)" "arm64"
assert_eq "normalize_arch aarch64" "$(normalize_arch aarch64 0)" "arm64"
# A shell under Rosetta on Apple Silicon reports x86_64; proc_translated=1
# is the only signal that the machine is really arm64.
assert_eq "normalize_arch corrects Rosetta" "$(normalize_arch x86_64 1)" "arm64"
assert_eq "normalize_arch defaults translated to 0" "$(normalize_arch x86_64)" "amd64"
assert_fails "normalize_arch rejects i386" normalize_arch i386 0
assert_fails "normalize_arch rejects armv7l" normalize_arch armv7l 0

# ── asset_name ───────────────────────────────────────────────
assert_eq "asset_name darwin amd64" "$(asset_name darwin amd64)" "devdeck-runtime-darwin-amd64"
assert_eq "asset_name darwin arm64" "$(asset_name darwin arm64)" "devdeck-runtime-darwin-arm64"
assert_eq "asset_name linux amd64" "$(asset_name linux amd64)" "devdeck-runtime-linux-amd64"
assert_eq "asset_name linux arm64" "$(asset_name linux arm64)" "devdeck-runtime-linux-arm64"
assert_eq "asset_name windows amd64" "$(asset_name windows amd64)" "devdeck-runtime-windows-amd64.exe"
assert_eq "asset_name windows arm64" "$(asset_name windows arm64)" "devdeck-runtime-windows-arm64.exe"

# ── port_of ──────────────────────────────────────────────────
assert_eq "port_of loopback" "$(port_of 127.0.0.1:8989)" "8989"
assert_eq "port_of wildcard" "$(port_of 0.0.0.0:9199)" "9199"
assert_eq "port_of bare colon" "$(port_of :8080)" "8080"

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh scripts/test/install_test.sh`
Expected: FAIL — `scripts/install.sh: No such file or directory`.

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/install.sh`:

```sh
#!/bin/sh
# DevDeck one-line installer.
#
#   curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | GITHUB_TOKEN=ghp_xxx sh
#
# Downloads the release binary for this platform, installs it under
# ~/.local/bin, and — when DEVDECK_HUB_URL and DEVDECK_HUB_KEY are set —
# registers this machine as a runtime against that hub.
#
# Design: docs/superpowers/specs/2026-07-26-install-scripts-design.md
#
# POSIX sh only (dash, ash/busybox, bash, zsh). `set -eu` lives inside
# main() so scripts/test/install_test.sh can source this file safely, and
# every statement lives inside a function so a truncated download executes
# nothing at all.

OWNER="${DEVDECK_REPO_OWNER:-ItsMyEyes}"
REPO="${DEVDECK_REPO_NAME:-devdeck}"
API="${DEVDECK_GITHUB_API:-https://api.github.com}"
BIN_NAME="devdeck"

info() { printf 'devdeck: %s\n' "$1" >&2; }
warn() { printf 'devdeck: warning: %s\n' "$1" >&2; }

die() {
	printf 'devdeck: %s\n' "$1" >&2
	exit 1
}

# normalize_os maps `uname -s` output onto a Go GOOS value.
normalize_os() {
	case "${1:-}" in
	Darwin) printf 'darwin' ;;
	Linux) printf 'linux' ;;
	*) return 1 ;;
	esac
}

# normalize_arch maps `uname -m` output onto a Go GOARCH value. $2 carries
# `sysctl -n sysctl.proc_translated` (1 = running under Rosetta), because a
# translated shell on Apple Silicon reports x86_64 and would otherwise
# install the emulated build.
normalize_arch() {
	case "${1:-}" in
	x86_64 | amd64)
		if [ "${2:-0}" = "1" ]; then
			printf 'arm64'
		else
			printf 'amd64'
		fi
		;;
	arm64 | aarch64) printf 'arm64' ;;
	*) return 1 ;;
	esac
}

# asset_name returns the release asset filename for an os/arch pair. Must
# stay byte-identical to selfupdate.AssetName in
# backend/internal/selfupdate/asset.go.
asset_name() {
	if [ "$1" = "windows" ]; then
		printf 'devdeck-runtime-%s-%s.exe' "$1" "$2"
	else
		printf 'devdeck-runtime-%s-%s' "$1" "$2"
	fi
}

# port_of extracts the port from a host:port listen address.
port_of() {
	printf '%s' "${1##*:}"
}

# detect_platform prints "<os> <arch>", resolving Rosetta on Darwin.
detect_platform() {
	uname_s=$(uname -s)
	uname_m=$(uname -m)

	os=$(normalize_os "$uname_s") ||
		die "unsupported operating system '$uname_s' — this installer supports Linux and macOS; on Windows use install.ps1"

	translated=0
	if [ "$os" = "darwin" ]; then
		translated=$(sysctl -n sysctl.proc_translated 2>/dev/null || printf '0')
	fi

	arch=$(normalize_arch "$uname_m" "$translated") ||
		die "unsupported architecture '$uname_m' — supported: x86_64/amd64 and arm64/aarch64"

	printf '%s %s' "$os" "$arch"
}

main() {
	set -eu

	platform=$(detect_platform)
	os=${platform% *}
	arch=${platform#* }
	info "detected $os/$arch"
}

if [ "${DEVDECK_INSTALL_TEST:-0}" != "1" ]; then
	main "$@"
fi
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `chmod +x scripts/install.sh scripts/test/install_test.sh && sh scripts/test/install_test.sh`
Expected: `21 passed, 0 failed`, exit 0.

Also confirm the real detection path runs on this machine:

Run: `sh scripts/install.sh`
Expected: one line like `devdeck: detected darwin/arm64`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh scripts/test/install_test.sh
git commit -m "feat(scripts): add install.sh platform detection with unit tests

POSIX sh installer skeleton. set -eu lives inside main() and the entry
point is guarded on DEVDECK_INSTALL_TEST so the test harness can source
the file, and so a truncated curl|sh download executes nothing."
```

---

### Task 3: Release resolution — asset id and checksum parsing

The jq-less parser is the one genuinely fragile piece of this installer, so it gets the most test coverage. It relies on GitHub emitting `"url"`, `"id"`, `"node_id"`, `"name"` in that order inside each asset object, and on all whitespace being stripped first — the API pretty-prints, so `"id": 123` carries a space the pattern would otherwise miss. This was verified against a live `releases/latest` response on 2026-07-26.

**Files:**
- Modify: `scripts/install.sh`
- Modify: `scripts/test/install_test.sh`
- Create: `scripts/test/fixtures/release.json`
- Create: `scripts/test/fixtures/checksums.txt`

**Interfaces:**
- Consumes: `die`, `warn` from Task 2.
- Produces, for Task 4:
  - `parse_asset_id <asset-name>` — reads release JSON on stdin, prints the numeric asset id, exit 1 if not found
  - `checksum_for <asset-name>` — reads a `sha256sum`-format manifest on stdin, prints the hex digest, exit 1 if not found

- [ ] **Step 1: Write the failing test**

Create `scripts/test/fixtures/release.json`. It mirrors the real API shape: pretty-printed, `url`/`id`/`node_id`/`name` ordering, and a nested `uploader` object that itself contains an `id` — a naive greedy parser picks the uploader's id instead of the asset's, which is exactly what these tests catch.

```json
{
  "tag_name": "v1.4.0",
  "name": "v1.4.0",
  "assets": [
    {
      "url": "https://api.github.com/repos/ItsMyEyes/devdeck/releases/assets/111",
      "id": 111,
      "node_id": "RA_kwDOAAAA",
      "name": "devdeck-runtime-darwin-amd64",
      "label": null,
      "uploader": {
        "login": "github-actions[bot]",
        "id": 41898282
      },
      "content_type": "application/octet-stream",
      "state": "uploaded",
      "size": 26158640,
      "browser_download_url": "https://github.com/ItsMyEyes/devdeck/releases/download/v1.4.0/devdeck-runtime-darwin-amd64"
    },
    {
      "url": "https://api.github.com/repos/ItsMyEyes/devdeck/releases/assets/222",
      "id": 222,
      "node_id": "RA_kwDOBBBB",
      "name": "devdeck-runtime-linux-arm64",
      "label": null,
      "uploader": {
        "login": "github-actions[bot]",
        "id": 41898282
      },
      "content_type": "application/octet-stream",
      "state": "uploaded",
      "size": 24537603,
      "browser_download_url": "https://github.com/ItsMyEyes/devdeck/releases/download/v1.4.0/devdeck-runtime-linux-arm64"
    },
    {
      "url": "https://api.github.com/repos/ItsMyEyes/devdeck/releases/assets/333",
      "id": 333,
      "node_id": "RA_kwDOCCCC",
      "name": "devdeck-runtime-windows-amd64.exe",
      "label": null,
      "uploader": {
        "login": "github-actions[bot]",
        "id": 41898282
      },
      "content_type": "application/octet-stream",
      "state": "uploaded",
      "size": 26291200,
      "browser_download_url": "https://github.com/ItsMyEyes/devdeck/releases/download/v1.4.0/devdeck-runtime-windows-amd64.exe"
    },
    {
      "url": "https://api.github.com/repos/ItsMyEyes/devdeck/releases/assets/444",
      "id": 444,
      "node_id": "RA_kwDODDDD",
      "name": "checksums.txt",
      "label": null,
      "uploader": {
        "login": "github-actions[bot]",
        "id": 41898282
      },
      "content_type": "text/plain",
      "state": "uploaded",
      "size": 402,
      "browser_download_url": "https://github.com/ItsMyEyes/devdeck/releases/download/v1.4.0/checksums.txt"
    }
  ]
}
```

Create `scripts/test/fixtures/checksums.txt` in `sha256sum` output format (digest, two spaces, filename):

```
1111111111111111111111111111111111111111111111111111111111111111  devdeck-runtime-darwin-amd64
2222222222222222222222222222222222222222222222222222222222222222  devdeck-runtime-linux-arm64
3333333333333333333333333333333333333333333333333333333333333333  devdeck-runtime-windows-amd64.exe
```

Append to `scripts/test/install_test.sh`, immediately before the final `printf`/exit lines:

```sh
FIXTURES="$SCRIPT_DIR/test/fixtures"

# ── parse_asset_id ───────────────────────────────────────────
assert_eq "parse_asset_id first asset" \
	"$(parse_asset_id devdeck-runtime-darwin-amd64 <"$FIXTURES/release.json")" "111"
assert_eq "parse_asset_id middle asset" \
	"$(parse_asset_id devdeck-runtime-linux-arm64 <"$FIXTURES/release.json")" "222"
assert_eq "parse_asset_id .exe asset" \
	"$(parse_asset_id devdeck-runtime-windows-amd64.exe <"$FIXTURES/release.json")" "333"
assert_eq "parse_asset_id checksums manifest" \
	"$(parse_asset_id checksums.txt <"$FIXTURES/release.json")" "444"
# The nested uploader object carries its own "id" — a greedy parser returns
# 41898282 here instead of the asset id.
assert_fails "parse_asset_id rejects a missing asset" \
	sh -c ". '$SCRIPT_DIR/install.sh'; parse_asset_id devdeck-runtime-linux-amd64 < '$FIXTURES/release.json'"
assert_fails "parse_asset_id rejects a malformed body" \
	sh -c ". '$SCRIPT_DIR/install.sh'; printf 'not json' | parse_asset_id devdeck-runtime-darwin-amd64"

# ── checksum_for ─────────────────────────────────────────────
assert_eq "checksum_for darwin" \
	"$(checksum_for devdeck-runtime-darwin-amd64 <"$FIXTURES/checksums.txt")" \
	"1111111111111111111111111111111111111111111111111111111111111111"
assert_eq "checksum_for .exe" \
	"$(checksum_for devdeck-runtime-windows-amd64.exe <"$FIXTURES/checksums.txt")" \
	"3333333333333333333333333333333333333333333333333333333333333333"
assert_fails "checksum_for rejects a missing entry" \
	sh -c ". '$SCRIPT_DIR/install.sh'; checksum_for devdeck-runtime-linux-amd64 < '$FIXTURES/checksums.txt'"
```

Note the `assert_fails` cases run in a subshell with `DEVDECK_INSTALL_TEST` still exported, so sourcing `install.sh` there defines the functions without running `main`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh scripts/test/install_test.sh`
Expected: FAIL — `parse_asset_id: not found` for each new assertion.

- [ ] **Step 3: Write the minimal implementation**

Insert into `scripts/install.sh` after `port_of`:

```sh
# parse_asset_id reads a GitHub release JSON body on stdin and prints the
# numeric id of the asset named $1.
#
# jq is used when present. The fallback exists because a freshly-imaged
# machine rarely has jq, and it anchors on GitHub's field order within an
# asset object (url, id, node_id, name). All whitespace is stripped first
# because the API pretty-prints its JSON. Anchoring on the id/node_id/name
# run is what keeps the nested "uploader" object's own id from matching.
parse_asset_id() {
	want="$1"
	id=""

	if command -v jq >/dev/null 2>&1; then
		id=$(jq -r --arg n "$want" 'first(.assets[]? | select(.name == $n) | .id) // empty' 2>/dev/null || printf '')
	else
		id=$(tr -d ' \n\t\r' |
			grep -o '"id":[0-9][0-9]*,"node_id":"[^"]*","name":"'"$want"'"' |
			head -n 1 |
			sed -n 's/^"id":\([0-9][0-9]*\).*/\1/p')
	fi

	case "$id" in
	'' | *[!0-9]*)
		return 1
		;;
	esac

	printf '%s' "$id"
}

# checksum_for reads a sha256sum-format manifest on stdin and prints the
# digest for the file named $1. GNU sha256sum prefixes binary-mode names
# with '*', so both forms are accepted.
checksum_for() {
	awk -v name="$1" '$2 == name || $2 == "*" name { print $1; found = 1; exit } END { exit !found }'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `sh scripts/test/install_test.sh`
Expected: `30 passed, 0 failed`, exit 0.

Then prove the fallback path independently of the jq path — this is the branch that actually runs on a bare machine:

Run: `PATH=/usr/bin:/bin sh -c 'command -v jq' || sh scripts/test/install_test.sh`
Better, force it explicitly:

```bash
DEVDECK_INSTALL_TEST=1 sh -c '
  . scripts/install.sh
  command() { return 1; }          # make `command -v jq` fail
  parse_asset_id devdeck-runtime-linux-arm64 < scripts/test/fixtures/release.json
'
```
Expected: `222`.

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh scripts/test/install_test.sh scripts/test/fixtures
git commit -m "feat(scripts): resolve release asset ids and checksums

parse_asset_id prefers jq and falls back to a text scan for bare
machines. The fixture nests an uploader object carrying its own id, so
the tests fail if the fallback ever grows greedy enough to match it."
```

---

### Task 4: Download, verify, and install the binary

**Files:**
- Modify: `scripts/install.sh`

**Interfaces:**
- Consumes: `detect_platform`, `asset_name`, `parse_asset_id`, `checksum_for`, `die`, `info`, `warn` from Tasks 2–3.
- Produces, for Task 5:
  - `INSTALL_PATH` — global set by `install_binary`, the absolute path of the installed binary
  - `require_token` → prints the resolved token, exits 1 with guidance when unset
  - `sha256_of <file>` → prints the file's hex digest

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/install_test.sh`, before the final `printf`:

```sh
# ── http_get / fetch tooling ─────────────────────────────────
# require_token resolves GITHUB_TOKEN then GH_TOKEN, and fails when neither
# is set — the private repo makes an anonymous install impossible.
assert_eq "require_token prefers GITHUB_TOKEN" \
	"$(GITHUB_TOKEN=aaa GH_TOKEN=bbb require_token)" "aaa"
assert_eq "require_token falls back to GH_TOKEN" \
	"$(GITHUB_TOKEN= GH_TOKEN=bbb require_token)" "bbb"
assert_fails "require_token rejects both unset" \
	sh -c ". '$SCRIPT_DIR/install.sh'; GITHUB_TOKEN= GH_TOKEN= require_token"

# ── sha256_of ────────────────────────────────────────────────
# Digest of the empty string, a value every SHA-256 implementation agrees on.
: >"$FIXTURES/empty.bin"
assert_eq "sha256_of empty file" "$(sha256_of "$FIXTURES/empty.bin")" \
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
rm -f "$FIXTURES/empty.bin"

# ── resolve_install_dir ──────────────────────────────────────
assert_eq "resolve_install_dir honours the override" \
	"$(DEVDECK_INSTALL_DIR=/opt/dd resolve_install_dir)" "/opt/dd"
assert_eq "resolve_install_dir defaults under HOME" \
	"$(HOME=/home/tester DEVDECK_INSTALL_DIR= resolve_install_dir)" "/home/tester/.local/bin"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh scripts/test/install_test.sh`
Expected: FAIL — `require_token: not found`.

- [ ] **Step 3: Write the minimal implementation**

Insert into `scripts/install.sh` after `checksum_for`:

```sh
# require_token resolves the GitHub token. The repo is private, so there is
# no anonymous path — failing here with instructions beats a confusing 404
# three steps later.
require_token() {
	token="${GITHUB_TOKEN:-}"
	if [ -z "$token" ]; then
		token="${GH_TOKEN:-}"
	fi
	if [ -z "$token" ]; then
		die "GITHUB_TOKEN is required — $OWNER/$REPO is a private repository.
  Create a fine-grained token with 'Contents: read' on $OWNER/$REPO at
  https://github.com/settings/personal-access-tokens/new then re-run:
    curl -fsSL <this-url> | GITHUB_TOKEN=ghp_xxx sh"
	fi
	printf '%s' "$token"
}

# resolve_install_dir picks the destination directory. Always under $HOME by
# default — an installer piped from the internet must never need sudo.
resolve_install_dir() {
	if [ -n "${DEVDECK_INSTALL_DIR:-}" ]; then
		printf '%s' "$DEVDECK_INSTALL_DIR"
	else
		printf '%s/.local/bin' "$HOME"
	fi
}

# have checks whether a command exists on PATH.
have() { command -v "$1" >/dev/null 2>&1; }

# http_get fetches $1 to stdout with the given Accept header ($2) and the
# bearer token ($3). curl is preferred; wget covers minimal images that ship
# only busybox wget. Both are told to fail loudly on HTTP errors.
http_get() {
	url="$1"
	accept="$2"
	token="$3"

	if have curl; then
		curl -fsSL \
			-H "Authorization: Bearer $token" \
			-H "Accept: $accept" \
			-H "X-GitHub-Api-Version: 2022-11-28" \
			"$url"
	elif have wget; then
		wget -qO- \
			--header="Authorization: Bearer $token" \
			--header="Accept: $accept" \
			--header="X-GitHub-Api-Version: 2022-11-28" \
			"$url"
	else
		die "neither curl nor wget is available — install one of them and re-run"
	fi
}

# http_status prints only the HTTP status code for $1, used to turn an
# opaque transfer failure into a specific message.
http_status() {
	if have curl; then
		curl -o /dev/null -s -w '%{http_code}' \
			-H "Authorization: Bearer $2" \
			-H "Accept: application/vnd.github+json" \
			"$1" 2>/dev/null || printf '000'
	else
		printf '000'
	fi
}

# release_url returns the API endpoint for the requested release: the pinned
# tag when DEVDECK_VERSION is set, otherwise the latest published release.
release_url() {
	version="${DEVDECK_VERSION:-latest}"
	if [ "$version" = "latest" ]; then
		printf '%s/repos/%s/%s/releases/latest' "$API" "$OWNER" "$REPO"
	else
		printf '%s/repos/%s/%s/releases/tags/%s' "$API" "$OWNER" "$REPO" "$version"
	fi
}

# explain_release_failure maps a status code onto the actual cause. A 404
# here means one of three very different things, and guessing wastes the
# user's time.
explain_release_failure() {
	case "$1" in
	401 | 403)
		die "GitHub rejected the token (HTTP $1) — check it is not expired and has 'Contents: read' on $OWNER/$REPO"
		;;
	404)
		die "no release found (HTTP 404) — either the token cannot see the private repo $OWNER/$REPO, or the tag '${DEVDECK_VERSION:-latest}' does not exist.
  Note: $OWNER/$REPO has no published releases until a v*.*.* tag is pushed."
		;;
	*)
		die "could not fetch the release metadata (HTTP $1)"
		;;
	esac
}

# sha256_of prints the SHA-256 of a file. GNU coreutils ships sha256sum,
# macOS ships shasum; openssl is the last resort.
sha256_of() {
	if have sha256sum; then
		sha256sum "$1" | awk '{print $1}'
	elif have shasum; then
		shasum -a 256 "$1" | awk '{print $1}'
	elif have openssl; then
		openssl dgst -sha256 "$1" | awk '{print $NF}'
	else
		return 1
	fi
}

# verify_checksum compares the downloaded binary against the release
# manifest. A manifest that is present and disagrees is fatal. A manifest
# that is absent is only a warning: checksums.txt is newer than the release
# workflow, so releases cut before it exists must still be installable.
verify_checksum() {
	file="$1"
	name="$2"
	manifest="$3"

	if [ ! -s "$manifest" ]; then
		warn "release has no checksums.txt — skipping integrity verification"
		return 0
	fi

	want=$(checksum_for "$name" <"$manifest") || {
		warn "checksums.txt has no entry for $name — skipping integrity verification"
		return 0
	}

	got=$(sha256_of "$file") || {
		warn "no sha256 tool available (sha256sum/shasum/openssl) — skipping integrity verification"
		return 0
	}

	if [ "$got" != "$want" ]; then
		die "checksum mismatch for $name
  expected: $want
  actual:   $got
  The download was corrupted or tampered with. Nothing was installed."
	fi

	info "checksum verified"
}

# install_binary moves the verified download into place and sets
# INSTALL_PATH. The temp file is created in the destination directory so the
# final mv is a same-filesystem rename — atomic, so a concurrent or
# interrupted run never leaves a half-written binary named devdeck.
install_binary() {
	src="$1"
	dir=$(resolve_install_dir)

	mkdir -p "$dir" 2>/dev/null ||
		die "cannot create $dir — set DEVDECK_INSTALL_DIR to a writable directory"
	[ -w "$dir" ] ||
		die "$dir is not writable — set DEVDECK_INSTALL_DIR to a writable directory"

	staged="$dir/.$BIN_NAME.$$"
	cp "$src" "$staged" || die "could not stage the binary in $dir"
	chmod 755 "$staged" || die "could not make $staged executable"
	mv -f "$staged" "$dir/$BIN_NAME" || die "could not install into $dir"

	INSTALL_PATH="$dir/$BIN_NAME"
	info "installed $INSTALL_PATH"

	case ":$PATH:" in
	*":$dir:"*) ;;
	*)
		warn "$dir is not on your PATH — add it with:
    echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile && export PATH=\"$dir:\$PATH\""
		;;
	esac
}
```

Now replace `main()` with the full download pipeline:

```sh
main() {
	set -eu

	platform=$(detect_platform)
	os=${platform% *}
	arch=${platform#* }
	info "detected $os/$arch"

	token=$(require_token)
	name=$(asset_name "$os" "$arch")

	WORK_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t devdeck) ||
		die "could not create a temporary directory"
	trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

	info "resolving ${DEVDECK_VERSION:-latest} release..."
	url=$(release_url)
	http_get "$url" "application/vnd.github+json" "$token" >"$WORK_DIR/release.json" ||
		explain_release_failure "$(http_status "$url" "$token")"

	asset_id=$(parse_asset_id "$name" <"$WORK_DIR/release.json") ||
		die "release has no asset named $name.
  Either this platform was not built for that release, or the GitHub API
  response shape changed — installing jq and re-running uses a more robust parser."

	info "downloading $name..."
	http_get "$API/repos/$OWNER/$REPO/releases/assets/$asset_id" \
		"application/octet-stream" "$token" >"$WORK_DIR/$name" ||
		die "failed to download $name"
	[ -s "$WORK_DIR/$name" ] || die "downloaded $name is empty"

	# A missing manifest is expected on older releases, so this failure is
	# swallowed here and reported by verify_checksum.
	if sums_id=$(parse_asset_id checksums.txt <"$WORK_DIR/release.json" 2>/dev/null); then
		http_get "$API/repos/$OWNER/$REPO/releases/assets/$sums_id" \
			"application/octet-stream" "$token" >"$WORK_DIR/checksums.txt" 2>/dev/null || true
	fi
	verify_checksum "$WORK_DIR/$name" "$name" "$WORK_DIR/checksums.txt"

	install_binary "$WORK_DIR/$name"
	info "$("$INSTALL_PATH" --version 2>/dev/null || printf 'installed')"
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh scripts/test/install_test.sh`
Expected: `36 passed, 0 failed`, exit 0.

Run: `shellcheck -s sh scripts/install.sh scripts/test/install_test.sh`
Expected: no output. (If `shellcheck` is not installed locally: `brew install shellcheck`. CI runs it either way — Task 8.)

Verify the no-token error path is the first thing a user hits:

Run: `env -u GITHUB_TOKEN -u GH_TOKEN sh scripts/install.sh; echo "exit=$?"`
Expected: the `GITHUB_TOKEN is required` message with the token-creation URL, `exit=1`.

Verify the real network path end to end. **This only works once a release exists** — see the plan's Manual Verification section. Until then, confirm the 404 branch reports the right cause:

Run: `GITHUB_TOKEN=$(gh auth token) sh scripts/install.sh; echo "exit=$?"`
Expected: the `no release found (HTTP 404)` message including the "no published releases until a v*.*.* tag is pushed" note, `exit=1`.

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh scripts/test/install_test.sh
git commit -m "feat(scripts): download, verify, and install the release binary

Uses the authenticated asset API (required for a private repo), verifies
SHA-256 against the release manifest, and installs via a same-filesystem
rename so an interrupted run cannot leave a partial binary in place.
Never escalates: an unwritable target names DEVDECK_INSTALL_DIR instead."
```

---

### Task 5: Configure, start, and confirm runtime self-registration

**Files:**
- Modify: `scripts/install.sh`
- Modify: `scripts/test/install_test.sh`

**Interfaces:**
- Consumes: `INSTALL_PATH`, `port_of`, `die`, `info`, `warn`, `have`, `http_get` from Tasks 2–4.
- Produces: nothing consumed by later tasks — this closes `install.sh`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/install_test.sh`, before the final `printf`:

```sh
# ── resolve_addr ─────────────────────────────────────────────
# Self-registering means the hub has to reach this process, so the default
# binds all interfaces. --role runtime refuses to start without --key, so
# every route but /api/health is behind bearer auth either way.
assert_eq "resolve_addr binds wide when self-registering" \
	"$(DEVDECK_ADDR= resolve_addr 1)" "0.0.0.0:8989"
assert_eq "resolve_addr stays on loopback otherwise" \
	"$(DEVDECK_ADDR= resolve_addr 0)" "127.0.0.1:8989"
assert_eq "resolve_addr honours the override" \
	"$(DEVDECK_ADDR=10.0.0.5:9199 resolve_addr 1)" "10.0.0.5:9199"

# ── should_register ──────────────────────────────────────────
assert_eq "should_register with both vars" \
	"$(DEVDECK_HUB_URL=https://h DEVDECK_HUB_KEY=k should_register && echo yes)" "yes"
assert_eq "should_register without the key" \
	"$(DEVDECK_HUB_URL=https://h DEVDECK_HUB_KEY= should_register || echo no)" "no"
assert_eq "should_register without the url" \
	"$(DEVDECK_HUB_URL= DEVDECK_HUB_KEY=k should_register || echo no)" "no"

# ── config_path ──────────────────────────────────────────────
assert_eq "config_path honours XDG_CONFIG_HOME" \
	"$(XDG_CONFIG_HOME=/x/cfg config_path)" "/x/cfg/devdeck/runtime.env"
assert_eq "config_path defaults under HOME" \
	"$(HOME=/home/tester XDG_CONFIG_HOME= config_path)" "/home/tester/.config/devdeck/runtime.env"

# ── generate_key ─────────────────────────────────────────────
GEN_KEY=$(generate_key)
assert_eq "generate_key returns 64 hex chars" "$(printf '%s' "$GEN_KEY" | wc -c | tr -d ' ')" "64"
assert_eq "generate_key is hex only" \
	"$(printf '%s' "$GEN_KEY" | tr -d '0-9a-f' | wc -c | tr -d ' ')" "0"
assert_eq "generate_key is not constant" \
	"$([ "$(generate_key)" != "$(generate_key)" ] && echo differs)" "differs"

# ── machine_registered ───────────────────────────────────────
# Matches on the JSON-encoded name field rather than a bare substring, so a
# machine called "web" does not match an unrelated "webhook-runner".
assert_eq "machine_registered finds an exact name" \
	"$(printf '[{"id":"m-1","name":"my-laptop"}]' | machine_registered my-laptop && echo yes)" "yes"
assert_eq "machine_registered rejects a prefix collision" \
	"$(printf '[{"id":"m-1","name":"my-laptop-2"}]' | machine_registered my-laptop || echo no)" "no"
assert_eq "machine_registered rejects an empty list" \
	"$(printf '[]' | machine_registered my-laptop || echo no)" "no"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh scripts/test/install_test.sh`
Expected: FAIL — `resolve_addr: not found`.

- [ ] **Step 3: Write the minimal implementation**

Insert into `scripts/install.sh` after `install_binary`:

```sh
# should_register reports whether enough was supplied to self-register.
# Both halves are required: a URL without a key cannot authenticate, and a
# key without a URL has nowhere to go.
should_register() {
	[ -n "${DEVDECK_HUB_URL:-}" ] && [ -n "${DEVDECK_HUB_KEY:-}" ]
}

# resolve_addr picks the listen address. $1 is 1 when self-registering, in
# which case the default binds every interface so the hub can reach this
# runtime — safe because --role runtime refuses to start without --key.
resolve_addr() {
	if [ -n "${DEVDECK_ADDR:-}" ]; then
		printf '%s' "$DEVDECK_ADDR"
	elif [ "$1" = "1" ]; then
		printf '0.0.0.0:8989'
	else
		printf '127.0.0.1:8989'
	fi
}

# config_path is where the generated env file lives.
config_path() {
	if [ -n "${XDG_CONFIG_HOME:-}" ]; then
		printf '%s/devdeck/runtime.env' "$XDG_CONFIG_HOME"
	else
		printf '%s/.config/devdeck/runtime.env' "$HOME"
	fi
}

# log_path is where the detached runtime's output goes.
log_path() {
	if [ -n "${XDG_STATE_HOME:-}" ]; then
		printf '%s/devdeck/runtime.log' "$XDG_STATE_HOME"
	else
		printf '%s/.local/state/devdeck/runtime.log' "$HOME"
	fi
}

# generate_key returns 32 random bytes as 64 hex characters, matching the
# shape of the keys the hub already issues.
generate_key() {
	if have openssl; then
		openssl rand -hex 32
	elif [ -r /dev/urandom ]; then
		od -An -tx1 -N 32 </dev/urandom | tr -d ' \n'
	else
		die "no source of randomness (openssl or /dev/urandom) — set DEVDECK_KEY explicitly"
	fi
}

# detect_public_url guesses the URL to advertise to the hub. Tailscale is
# checked first because that is how DevDeck expects hub and runtime to
# reach each other; DEVDECK_PUBLIC_URL overrides all of it.
detect_public_url() {
	port="$1"

	if have tailscale; then
		ts_ip=$(tailscale ip -4 2>/dev/null | head -n 1 || printf '')
		if [ -n "$ts_ip" ]; then
			printf 'http://%s:%s' "$ts_ip" "$port"
			return 0
		fi
	fi

	ip=""
	if have ipconfig; then
		ip=$(ipconfig getifaddr en0 2>/dev/null || printf '')
	fi
	if [ -z "$ip" ] && have hostname; then
		ip=$(hostname -I 2>/dev/null | awk '{print $1}' || printf '')
	fi
	if [ -z "$ip" ]; then
		ip=$(uname -n)
	fi

	printf 'http://%s:%s' "$ip" "$port"
}

# write_config writes the runtime env file at mode 0600. An existing file is
# backed up first: re-running the installer must never silently destroy a
# key the hub has already registered.
write_config() {
	cfg=$(config_path)
	mkdir -p "$(dirname "$cfg")" || die "could not create $(dirname "$cfg")"

	if [ -f "$cfg" ]; then
		cp "$cfg" "$cfg.bak" || die "could not back up $cfg"
		warn "existing config backed up to $cfg.bak"
	fi

	umask 077
	cat >"$cfg" <<EOF
# Generated by the DevDeck installer. Sourced before starting the runtime.
DEVDECK_ROLE=$DD_ROLE
DEVDECK_KEY=$DD_KEY
DEVDECK_ADDR=$DD_ADDR
DEVDECK_HUB_URL=$DD_HUB_URL
DEVDECK_HUB_KEY=$DD_HUB_KEY
DEVDECK_PUBLIC_URL=$DD_PUBLIC_URL
DEVDECK_MACHINE_NAME=$DD_NAME
EOF
	chmod 600 "$cfg" || die "could not restrict permissions on $cfg"
	info "wrote $cfg"
}

# start_runtime launches the binary detached. Deliberately not a service:
# this plan does not install systemd units, launchd plists, or Scheduled
# Tasks, so the process does not survive a reboot and the script says so.
start_runtime() {
	logf=$(log_path)
	mkdir -p "$(dirname "$logf")" || die "could not create $(dirname "$logf")"

	DEVDECK_ROLE="$DD_ROLE" \
		DEVDECK_KEY="$DD_KEY" \
		DEVDECK_ADDR="$DD_ADDR" \
		DEVDECK_HUB_URL="$DD_HUB_URL" \
		DEVDECK_HUB_KEY="$DD_HUB_KEY" \
		DEVDECK_PUBLIC_URL="$DD_PUBLIC_URL" \
		DEVDECK_MACHINE_NAME="$DD_NAME" \
		nohup "$INSTALL_PATH" --open=false >>"$logf" 2>&1 &

	RUNTIME_PID=$!
	info "started pid $RUNTIME_PID, logging to $logf"
}

# wait_healthy polls the runtime's public health endpoint until it answers.
wait_healthy() {
	port=$(port_of "$DD_ADDR")
	i=0
	while [ "$i" -lt 30 ]; do
		if have curl; then
			if curl -fsS -o /dev/null "http://127.0.0.1:$port/api/health" 2>/dev/null; then
				return 0
			fi
		elif have wget; then
			if wget -qO- "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
				return 0
			fi
		fi
		i=$((i + 1))
		sleep 1
	done
	return 1
}

# machine_registered reads the hub's /api/machines response on stdin and
# reports whether $1 is present. The pattern includes the closing quote so a
# machine named "web" does not match "webhook-runner".
machine_registered() {
	grep -q "\"name\":[ ]*\"$1\"" 2>/dev/null
}

# confirm_registration is the difference between "the process started" and
# "the hub knows about this machine". Only the second one is success.
confirm_registration() {
	if ! wait_healthy; then
		die "the runtime did not become healthy within 30s — check $(log_path)"
	fi
	info "runtime is healthy"

	machines=$(http_get "$DD_HUB_URL/api/machines" "application/json" "$DD_HUB_KEY" 2>/dev/null || printf '')
	if [ -z "$machines" ]; then
		die "could not read $DD_HUB_URL/api/machines — check DEVDECK_HUB_URL and DEVDECK_HUB_KEY"
	fi

	if printf '%s' "$machines" | machine_registered "$DD_NAME"; then
		info "registered with the hub as '$DD_NAME'"
	else
		die "the runtime is running but did not appear in $DD_HUB_URL/api/machines as '$DD_NAME' — check $(log_path)"
	fi
}

# register runs the whole self-registration sequence.
register() {
	DD_ROLE="${DEVDECK_ROLE:-runtime}"
	case "$DD_ROLE" in
	runtime | hub | both) ;;
	*) die "DEVDECK_ROLE must be runtime, hub, or both — got '$DD_ROLE'" ;;
	esac

	DD_ADDR=$(resolve_addr 1)
	DD_KEY="${DEVDECK_KEY:-}"
	[ -n "$DD_KEY" ] || DD_KEY=$(generate_key)
	DD_HUB_URL="${DEVDECK_HUB_URL}"
	DD_HUB_KEY="${DEVDECK_HUB_KEY}"
	DD_NAME="${DEVDECK_MACHINE_NAME:-$(uname -n)}"
	DD_PUBLIC_URL="${DEVDECK_PUBLIC_URL:-}"
	[ -n "$DD_PUBLIC_URL" ] || DD_PUBLIC_URL=$(detect_public_url "$(port_of "$DD_ADDR")")

	write_config

	if [ "${DEVDECK_NO_START:-0}" = "1" ]; then
		info "DEVDECK_NO_START=1 — not starting. Run it with:
    set -a; . $(config_path); set +a; $INSTALL_PATH --open=false"
		return 0
	fi

	start_runtime
	confirm_registration

	info "note: this process does not survive a reboot — no service was installed.
  Start it again with:
    set -a; . $(config_path); set +a; nohup $INSTALL_PATH --open=false >> $(log_path) 2>&1 &"
}
```

Append to the end of `main()`, after the `install_binary` line:

```sh
	if should_register; then
		register
	else
		info "install complete. To register this machine as a runtime, re-run with
  DEVDECK_HUB_URL and DEVDECK_HUB_KEY set, or start it yourself:
    $INSTALL_PATH --role runtime --key <key> --hub-url <url> --hub-key <key>"
	fi
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh scripts/test/install_test.sh`
Expected: `50 passed, 0 failed`, exit 0.

Run: `shellcheck -s sh scripts/install.sh scripts/test/install_test.sh`
Expected: no output.

Confirm the install-only branch still prints guidance rather than registering:

Run: `env -u DEVDECK_HUB_URL -u DEVDECK_HUB_KEY GITHUB_TOKEN=$(gh auth token) sh scripts/install.sh; echo "exit=$?"`
Expected: fails at the release step with the 404 explanation (no release exists yet), `exit=1` — it must not reach the registration branch.

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh scripts/test/install_test.sh
git commit -m "feat(scripts): self-register the machine as a runtime

Writes a 0600 env file (backing up any existing one so a re-run cannot
destroy a key the hub already knows), starts the binary detached, then
confirms against the hub's /api/machines. A local health check alone
would report success for a runtime the hub never registered."
```

---

### Task 6: `install.ps1`

**Files:**
- Create: `scripts/install.ps1`

**Interfaces:**
- Consumes: the asset naming and env contract from Tasks 1–5 (behavioural parity, no code sharing).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

PowerShell has no test harness in this repo and adding Pester to CI is out of scope, so this task's gate is an assertion script that a developer runs on Windows. Create it as part of the implementation step below and run it in Step 4. Write the expectations down first:

| Function | Input | Expected |
|---|---|---|
| `Get-DevDeckAssetName` | `windows`, `amd64` | `devdeck-runtime-windows-amd64.exe` |
| `Get-DevDeckAssetName` | `windows`, `arm64` | `devdeck-runtime-windows-arm64.exe` |
| `Get-DevDeckArch` | `X64` | `amd64` |
| `Get-DevDeckArch` | `Arm64` | `arm64` |
| `Get-DevDeckArch` | `X86` | throws |
| `Resolve-DevDeckInstallDir` | `$env:DEVDECK_INSTALL_DIR = 'C:\dd'` | `C:\dd` |
| `Resolve-DevDeckInstallDir` | unset | `$env:LOCALAPPDATA\DevDeck\bin` |

- [ ] **Step 2: Run the test to verify it fails**

Run (on Windows, or `pwsh` on any host): `pwsh -NoProfile -File scripts/test/install_ps_test.ps1`
Expected: FAIL — the script does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/install.ps1`:

```powershell
#Requires -Version 5.1
<#
.SYNOPSIS
    DevDeck one-line installer for Windows.

.DESCRIPTION
    $env:GITHUB_TOKEN = 'ghp_xxx'
    irm https://kiyora.is-a.dev/devdeck/install.ps1 | iex

    Downloads the release binary for this platform, installs it under
    %LOCALAPPDATA%\DevDeck\bin, and - when DEVDECK_HUB_URL and
    DEVDECK_HUB_KEY are set - registers this machine as a runtime.

    Design: docs/superpowers/specs/2026-07-26-install-scripts-design.md
    Targets Windows PowerShell 5.1, so no PS7-only syntax.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Owner = if ($env:DEVDECK_REPO_OWNER) { $env:DEVDECK_REPO_OWNER } else { 'ItsMyEyes' }
$script:Repo = if ($env:DEVDECK_REPO_NAME) { $env:DEVDECK_REPO_NAME } else { 'devdeck' }
$script:Api = if ($env:DEVDECK_GITHUB_API) { $env:DEVDECK_GITHUB_API } else { 'https://api.github.com' }

function Write-DevDeckInfo { param([string]$Message) Write-Host "devdeck: $Message" }
function Write-DevDeckWarn { param([string]$Message) Write-Warning "devdeck: $Message" }

# Get-DevDeckArch maps a .NET OSArchitecture (or PROCESSOR_ARCHITECTURE
# fallback) onto a Go GOARCH value.
function Get-DevDeckArch {
    param([string]$Raw)

    if (-not $Raw) {
        try {
            $Raw = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        }
        catch {
            # RuntimeInformation is unavailable on very old .NET Framework
            # builds; PROCESSOR_ARCHITEW6432 is set when a 32-bit shell runs
            # on a 64-bit OS, so it must be preferred over the plain value.
            $Raw = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
        }
    }

    switch -Regex ($Raw) {
        '^(X64|AMD64)$' { return 'amd64' }
        '^(Arm64|ARM64)$' { return 'arm64' }
        default { throw "unsupported architecture '$Raw' - supported: x64 and arm64" }
    }
}

# Get-DevDeckAssetName must stay byte-identical to selfupdate.AssetName in
# backend/internal/selfupdate/asset.go.
function Get-DevDeckAssetName {
    param([string]$Os, [string]$Arch)

    $name = "devdeck-runtime-$Os-$Arch"
    if ($Os -eq 'windows') { $name = "$name.exe" }
    return $name
}

function Resolve-DevDeckInstallDir {
    if ($env:DEVDECK_INSTALL_DIR) { return $env:DEVDECK_INSTALL_DIR }
    return (Join-Path $env:LOCALAPPDATA 'DevDeck\bin')
}

# Get-DevDeckToken fails early with instructions: the repo is private, so
# there is no anonymous path and a later 404 would be misleading.
function Get-DevDeckToken {
    $token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { $env:GH_TOKEN }
    if (-not $token) {
        throw @"
GITHUB_TOKEN is required - $script:Owner/$script:Repo is a private repository.
  Create a fine-grained token with 'Contents: read' on $script:Owner/$script:Repo at
  https://github.com/settings/personal-access-tokens/new then re-run:
    `$env:GITHUB_TOKEN='ghp_xxx'; irm <this-url> | iex
"@
    }
    return $token
}

function Get-DevDeckRelease {
    param([string]$Token)

    $version = if ($env:DEVDECK_VERSION) { $env:DEVDECK_VERSION } else { 'latest' }
    $url = if ($version -eq 'latest') {
        "$script:Api/repos/$script:Owner/$script:Repo/releases/latest"
    }
    else {
        "$script:Api/repos/$script:Owner/$script:Repo/releases/tags/$version"
    }

    # TLS 1.2 is not the default on Windows PowerShell 5.1; without this the
    # GitHub API call fails with an opaque "could not create SSL/TLS channel".
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $headers = @{
        Authorization          = "Bearer $Token"
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'devdeck-installer'
    }

    try {
        return Invoke-RestMethod -Uri $url -Headers $headers -UseBasicParsing
    }
    catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        switch ($status) {
            401 { throw "GitHub rejected the token (HTTP 401) - check it is not expired and has 'Contents: read' on $script:Owner/$script:Repo" }
            403 { throw "GitHub rejected the token (HTTP 403) - check it is not expired and has 'Contents: read' on $script:Owner/$script:Repo" }
            404 {
                throw @"
no release found (HTTP 404) - either the token cannot see the private repo $script:Owner/$script:Repo,
  or the tag '$version' does not exist.
  Note: $script:Owner/$script:Repo has no published releases until a v*.*.* tag is pushed.
"@
            }
            default { throw "could not fetch the release metadata: $($_.Exception.Message)" }
        }
    }
}

function Save-DevDeckAsset {
    param([object]$Release, [string]$Name, [string]$Token, [string]$Destination)

    $asset = $Release.assets | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if (-not $asset) {
        throw "release $($Release.tag_name) has no asset named $Name - this platform may not have been built for that release"
    }

    $headers = @{
        Authorization          = "Bearer $Token"
        Accept                 = 'application/octet-stream'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'devdeck-installer'
    }

    Invoke-WebRequest -Uri "$script:Api/repos/$script:Owner/$script:Repo/releases/assets/$($asset.id)" `
        -Headers $headers -OutFile $Destination -UseBasicParsing
}

# Test-DevDeckChecksum mirrors install.sh: a manifest that disagrees is
# fatal, a manifest that is absent is only a warning, because checksums.txt
# is newer than the release workflow.
function Test-DevDeckChecksum {
    param([object]$Release, [string]$Name, [string]$Token, [string]$File, [string]$WorkDir)

    $manifest = $Release.assets | Where-Object { $_.name -eq 'checksums.txt' } | Select-Object -First 1
    if (-not $manifest) {
        Write-DevDeckWarn 'release has no checksums.txt - skipping integrity verification'
        return
    }

    $manifestPath = Join-Path $WorkDir 'checksums.txt'
    Save-DevDeckAsset -Release $Release -Name 'checksums.txt' -Token $Token -Destination $manifestPath

    $line = Get-Content $manifestPath | Where-Object { $_ -match "\s\*?$([regex]::Escape($Name))$" } | Select-Object -First 1
    if (-not $line) {
        Write-DevDeckWarn "checksums.txt has no entry for $Name - skipping integrity verification"
        return
    }

    $want = ($line -split '\s+')[0]
    $got = (Get-FileHash -Path $File -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want.ToLower()) {
        throw "checksum mismatch for ${Name}: expected $want, got $got. Nothing was installed."
    }
    Write-DevDeckInfo 'checksum verified'
}

function Install-DevDeckBinary {
    param([string]$Source)

    $dir = Resolve-DevDeckInstallDir
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    $target = Join-Path $dir 'devdeck.exe'
    Move-Item -Path $Source -Destination $target -Force
    Write-DevDeckInfo "installed $target"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$dir*") {
        Write-DevDeckWarn "$dir is not on your PATH - add it with:`n    setx PATH `"$dir;%PATH%`""
    }

    return $target
}

function Get-DevDeckConfigPath {
    return (Join-Path $env:APPDATA 'DevDeck\runtime.env')
}

function Get-DevDeckLogPath {
    return (Join-Path $env:LOCALAPPDATA 'DevDeck\runtime.log')
}

function New-DevDeckKey {
    $bytes = New-Object 'System.Byte[]' 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-DevDeckPublicUrl {
    param([string]$Port)

    $ts = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($ts) {
        $ip = (& tailscale ip -4 2>$null | Select-Object -First 1)
        if ($ip) { return "http://${ip}:$Port" }
    }

    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress
    if (-not $ip) { $ip = $env:COMPUTERNAME }
    return "http://${ip}:$Port"
}

function Register-DevDeckRuntime {
    param([string]$BinaryPath)

    $role = if ($env:DEVDECK_ROLE) { $env:DEVDECK_ROLE } else { 'runtime' }
    if ($role -notin @('runtime', 'hub', 'both')) {
        throw "DEVDECK_ROLE must be runtime, hub, or both - got '$role'"
    }

    $addr = if ($env:DEVDECK_ADDR) { $env:DEVDECK_ADDR } else { '0.0.0.0:8989' }
    $port = $addr.Split(':')[-1]
    $key = if ($env:DEVDECK_KEY) { $env:DEVDECK_KEY } else { New-DevDeckKey }
    $name = if ($env:DEVDECK_MACHINE_NAME) { $env:DEVDECK_MACHINE_NAME } else { $env:COMPUTERNAME }
    $publicUrl = if ($env:DEVDECK_PUBLIC_URL) { $env:DEVDECK_PUBLIC_URL } else { Get-DevDeckPublicUrl -Port $port }

    $cfg = Get-DevDeckConfigPath
    New-Item -ItemType Directory -Path (Split-Path $cfg) -Force | Out-Null
    if (Test-Path $cfg) {
        Copy-Item $cfg "$cfg.bak" -Force
        Write-DevDeckWarn "existing config backed up to $cfg.bak"
    }

    @(
        '# Generated by the DevDeck installer.'
        "DEVDECK_ROLE=$role"
        "DEVDECK_KEY=$key"
        "DEVDECK_ADDR=$addr"
        "DEVDECK_HUB_URL=$($env:DEVDECK_HUB_URL)"
        "DEVDECK_HUB_KEY=$($env:DEVDECK_HUB_KEY)"
        "DEVDECK_PUBLIC_URL=$publicUrl"
        "DEVDECK_MACHINE_NAME=$name"
    ) | Set-Content -Path $cfg -Encoding ASCII
    Write-DevDeckInfo "wrote $cfg"

    if ($env:DEVDECK_NO_START -eq '1') {
        Write-DevDeckInfo "DEVDECK_NO_START=1 - not starting. Start it with:`n    $BinaryPath --open=false"
        return
    }

    $env:DEVDECK_ROLE = $role
    $env:DEVDECK_KEY = $key
    $env:DEVDECK_ADDR = $addr
    $env:DEVDECK_PUBLIC_URL = $publicUrl
    $env:DEVDECK_MACHINE_NAME = $name

    $log = Get-DevDeckLogPath
    New-Item -ItemType Directory -Path (Split-Path $log) -Force | Out-Null
    $proc = Start-Process -FilePath $BinaryPath -ArgumentList '--open=false' `
        -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru
    Write-DevDeckInfo "started pid $($proc.Id), logging to $log"

    $healthy = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
            $healthy = $true
            break
        }
        catch { Start-Sleep -Seconds 1 }
    }
    if (-not $healthy) { throw "the runtime did not become healthy within 30s - check $log" }
    Write-DevDeckInfo 'runtime is healthy'

    $machines = Invoke-RestMethod -Uri "$($env:DEVDECK_HUB_URL)/api/machines" `
        -Headers @{ Authorization = "Bearer $($env:DEVDECK_HUB_KEY)"; 'User-Agent' = 'devdeck-installer' } -UseBasicParsing
    if ($machines | Where-Object { $_.name -eq $name }) {
        Write-DevDeckInfo "registered with the hub as '$name'"
    }
    else {
        throw "the runtime is running but did not appear in $($env:DEVDECK_HUB_URL)/api/machines as '$name' - check $log"
    }

    Write-DevDeckInfo "note: this process does not survive a reboot - no service was installed."
}

function Invoke-DevDeckInstall {
    if (-not $IsWindowsHost) {
        throw 'install.ps1 targets Windows - on Linux and macOS use install.sh'
    }

    $arch = Get-DevDeckArch -Raw ''
    Write-DevDeckInfo "detected windows/$arch"

    $token = Get-DevDeckToken
    $name = Get-DevDeckAssetName -Os 'windows' -Arch $arch

    $workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("devdeck-" + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $workDir -Force | Out-Null
    try {
        Write-DevDeckInfo "resolving $(if ($env:DEVDECK_VERSION) { $env:DEVDECK_VERSION } else { 'latest' }) release..."
        $release = Get-DevDeckRelease -Token $token

        Write-DevDeckInfo "downloading $name..."
        $downloaded = Join-Path $workDir $name
        Save-DevDeckAsset -Release $release -Name $name -Token $token -Destination $downloaded

        Test-DevDeckChecksum -Release $release -Name $name -Token $token -File $downloaded -WorkDir $workDir
        $installed = Install-DevDeckBinary -Source $downloaded

        if ($env:DEVDECK_HUB_URL -and $env:DEVDECK_HUB_KEY) {
            Register-DevDeckRuntime -BinaryPath $installed
        }
        else {
            Write-DevDeckInfo @"
install complete. To register this machine as a runtime, re-run with
  `$env:DEVDECK_HUB_URL and `$env:DEVDECK_HUB_KEY set, or start it yourself:
    $installed --role runtime --key <key> --hub-url <url> --hub-key <key>
"@
        }
    }
    finally {
        Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
    }
}

# $IsWindows exists only on PowerShell 6+; on 5.1 the platform is always
# Windows. Computed before use so `irm | iex` and dot-sourcing agree.
$script:IsWindowsHost = if ($PSVersionTable.PSVersion.Major -ge 6) { $IsWindows } else { $true }

if ($env:DEVDECK_INSTALL_TEST -ne '1') {
    Invoke-DevDeckInstall
}
```

Create `scripts/test/install_ps_test.ps1`:

```powershell
#Requires -Version 5.1
# Assertion checks for the pure helpers in scripts/install.ps1.
# Run: pwsh -NoProfile -File scripts/test/install_ps_test.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$env:DEVDECK_INSTALL_TEST = '1'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'install.ps1')

$passed = 0
$failed = 0

function Assert-Eq {
    param([string]$Desc, $Got, $Want)
    if ($Got -eq $Want) { $script:passed++ }
    else {
        $script:failed++
        Write-Host "FAIL: $Desc`n  got:  $Got`n  want: $Want" -ForegroundColor Red
    }
}

function Assert-Throws {
    param([string]$Desc, [scriptblock]$Action)
    try { & $Action | Out-Null; $script:failed++; Write-Host "FAIL: $Desc (expected a throw)" -ForegroundColor Red }
    catch { $script:passed++ }
}

Assert-Eq 'asset name amd64' (Get-DevDeckAssetName -Os 'windows' -Arch 'amd64') 'devdeck-runtime-windows-amd64.exe'
Assert-Eq 'asset name arm64' (Get-DevDeckAssetName -Os 'windows' -Arch 'arm64') 'devdeck-runtime-windows-arm64.exe'
Assert-Eq 'arch X64' (Get-DevDeckArch -Raw 'X64') 'amd64'
Assert-Eq 'arch AMD64' (Get-DevDeckArch -Raw 'AMD64') 'amd64'
Assert-Eq 'arch Arm64' (Get-DevDeckArch -Raw 'Arm64') 'arm64'
Assert-Throws 'arch X86 is rejected' { Get-DevDeckArch -Raw 'X86' }

$env:DEVDECK_INSTALL_DIR = 'C:\dd'
Assert-Eq 'install dir override' (Resolve-DevDeckInstallDir) 'C:\dd'
$env:DEVDECK_INSTALL_DIR = ''
Assert-Eq 'install dir default' (Resolve-DevDeckInstallDir) (Join-Path $env:LOCALAPPDATA 'DevDeck\bin')

$key = New-DevDeckKey
Assert-Eq 'key length' $key.Length 64
Assert-Eq 'key is hex' ($key -match '^[0-9a-f]{64}$') $true
Assert-Eq 'key is not constant' ($key -ne (New-DevDeckKey)) $true

$env:GITHUB_TOKEN = ''
$env:GH_TOKEN = ''
Assert-Throws 'missing token is rejected' { Get-DevDeckToken }
$env:GITHUB_TOKEN = 'aaa'
Assert-Eq 'token from GITHUB_TOKEN' (Get-DevDeckToken) 'aaa'

Write-Host "`n$passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pwsh -NoProfile -File scripts/test/install_ps_test.ps1`
Expected: `13 passed, 0 failed`, exit 0.

If `pwsh` is not installed on the development machine, say so explicitly in the commit message and mark the PowerShell path as verified-on-Windows-only rather than claiming it passed. Do not claim a test ran that did not run.

- [ ] **Step 5: Commit**

```bash
git add scripts/install.ps1 scripts/test/install_ps_test.ps1
git commit -m "feat(scripts): add install.ps1 for Windows

Behavioural parity with install.sh: same env contract, same asset names,
same warn-on-missing/fail-on-mismatch checksum rule. Targets PowerShell
5.1, so it forces TLS 1.2 (not the default there) and computes the
Windows check rather than relying on \$IsWindows, which is PS6+ only."
```

---

### Task 7: `install.cmd` shim and `scripts/README.md`

**Files:**
- Create: `scripts/install.cmd`
- Create: `scripts/README.md`

**Interfaces:**
- Consumes: `install.ps1` from Task 6.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Batch has no test harness and the shim has no logic worth one. The gate is behavioural: running `scripts\install.cmd` with no token must surface `install.ps1`'s token error and exit non-zero. Record that expectation now and check it in Step 4.

- [ ] **Step 2: Run the test to verify it fails**

Run (Windows): `scripts\install.cmd`
Expected: FAIL — `'scripts\install.cmd' is not recognized`, because the file does not exist.

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/install.cmd`:

```bat
@echo off
:: DevDeck installer shim for cmd.exe.
::
::   curl -fsSL https://kiyora.is-a.dev/devdeck/install.cmd -o %TEMP%\dd.cmd && %TEMP%\dd.cmd
::
:: All the work happens in install.ps1. This file exists so the documented
:: cmd.exe path is something a user can download and read, rather than a
:: quoted one-liner they have to trust sight-unseen.
::
:: GITHUB_TOKEN and the DEVDECK_* variables need no forwarding - the
:: PowerShell child process inherits this shell's environment.
setlocal

if "%DEVDECK_INSTALL_URL%"=="" set "DEVDECK_INSTALL_URL=https://kiyora.is-a.dev/devdeck/install.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '%DEVDECK_INSTALL_URL%' | iex"
set "RC=%ERRORLEVEL%"

endlocal & exit /b %RC%
```

Create `scripts/README.md`:

```markdown
# Installer scripts

One-line installers for the DevDeck server binary. Design and rationale:
[`docs/superpowers/specs/2026-07-26-install-scripts-design.md`](../docs/superpowers/specs/2026-07-26-install-scripts-design.md).

| File | Platform |
|---|---|
| `install.sh` | Linux, macOS — POSIX `sh` (dash, ash/busybox, bash, zsh) |
| `install.ps1` | Windows — PowerShell 5.1+ and pwsh 7 |
| `install.cmd` | Windows — a shim that runs `install.ps1` via PowerShell |

## Usage

```bash
# Linux / macOS
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | GITHUB_TOKEN=ghp_xxx sh

# Linux / macOS, registering as a runtime against an existing hub
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | \
  GITHUB_TOKEN=ghp_xxx DEVDECK_HUB_URL=https://hub.ts.net DEVDECK_HUB_KEY=hubk sh
```

```powershell
$env:GITHUB_TOKEN="ghp_xxx"; irm https://kiyora.is-a.dev/devdeck/install.ps1 | iex
```

```bat
curl -fsSL https://kiyora.is-a.dev/devdeck/install.cmd -o %TEMP%\dd.cmd && %TEMP%\dd.cmd
```

`GITHUB_TOKEN` is required because `ItsMyEyes/devdeck` is private. Create a
fine-grained token with **Contents: read** on the repo. The scripts themselves
are served from the public Pages site, so only the binary download is
authenticated — read the script before you pipe it.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_TOKEN` / `GH_TOKEN` | — | **Required.** Fine-grained token, Contents: read. |
| `DEVDECK_VERSION` | `latest` | Pin to a tag, e.g. `v1.4.0`. |
| `DEVDECK_INSTALL_DIR` | `~/.local/bin`, `%LOCALAPPDATA%\DevDeck\bin` | Never needs sudo. |
| `DEVDECK_ROLE` | `runtime` | `runtime`, `hub`, or `both`. |
| `DEVDECK_ADDR` | `0.0.0.0:8989` self-registering, else `127.0.0.1:8989` | Listen address. |
| `DEVDECK_HUB_URL` + `DEVDECK_HUB_KEY` | — | Both set ⇒ self-registration runs. |
| `DEVDECK_KEY` | generated | This runtime's API key. |
| `DEVDECK_PUBLIC_URL` | Tailscale IP, else first non-loopback IP | Advertised to the hub. |
| `DEVDECK_MACHINE_NAME` | hostname | Name in the Machines UI. |
| `DEVDECK_NO_START` | unset | `1` writes config without starting anything. |

## What it does not do

No service is installed — no systemd unit, launchd plist, or Scheduled Task.
A runtime started by the installer **does not survive a reboot**; the script
prints the command to start it again.

## Tests

```bash
sh scripts/test/install_test.sh                       # POSIX helpers
shellcheck -s sh scripts/install.sh                   # lint
pwsh -NoProfile -File scripts/test/install_ps_test.ps1 # PowerShell helpers
```

Network and installation paths are verified manually — see the plan's Manual
Verification section.
```

- [ ] **Step 4: Verify the behaviour**

Run (Windows, no token set): `scripts\install.cmd`
Expected: the `GITHUB_TOKEN is required` message from `install.ps1`, non-zero exit code.

Run: `sh scripts/test/install_test.sh && shellcheck -s sh scripts/install.sh`
Expected: still green — this task must not regress Tasks 2–5.

- [ ] **Step 5: Commit**

```bash
git add scripts/install.cmd scripts/README.md
git commit -m "docs(scripts): add cmd.exe shim and installer README

The shim delegates to install.ps1 and exists so the documented cmd.exe
path is a file a user can read before running, not a quoted one-liner."
```

---

### Task 8: CI — publish the scripts, checksums, and lint

**Files:**
- Modify: `.github/workflows/deploy-docs.yml:43-45`
- Modify: `.github/workflows/release.yml:63-72`
- Modify: `.github/workflows/test.yml:27-33`

**Interfaces:**
- Consumes: `scripts/install.{sh,ps1,cmd}` and `scripts/test/install_test.sh` from Tasks 2–7.
- Produces: the public `https://kiyora.is-a.dev/devdeck/install.sh` URL and the `checksums.txt` release asset that Task 4's `verify_checksum` reads.

- [ ] **Step 1: Add the checksum step to the release workflow**

In `.github/workflows/release.yml`, immediately after the existing "Rename binaries for release" step, insert:

```yaml
      # The install scripts verify this manifest before putting anything on
      # disk. Generated after the rename so the names in checksums.txt are
      # the names the release actually publishes.
      - name: Generate checksums
        run: cd dist && sha256sum devdeck-runtime-* > checksums.txt
```

Then widen the upload so the manifest ships with the binaries:

```yaml
      - uses: actions/upload-artifact@v4
        with:
          name: backend-binaries
          path: |
            dist/devdeck-runtime-*
            dist/checksums.txt
          if-no-files-found: error
```

- [ ] **Step 2: Publish the scripts to the Pages site**

In `.github/workflows/deploy-docs.yml`, between "Build static export" and `upload-pages-artifact`, insert:

```yaml
      # The installer one-liners are fetched from the public Pages site, so a
      # private repo does not block them. scripts/ stays the single source of
      # truth and the copy happens at deploy time, so there is no second copy
      # to drift.
      - name: Stage installer scripts
        run: cp scripts/install.sh scripts/install.ps1 scripts/install.cmd docs-site/out/
```

- [ ] **Step 3: Lint and test the scripts on every push**

In `.github/workflows/test.yml`, after the "Go test" step, insert:

```yaml
      # shellcheck is preinstalled on ubuntu-latest runners.
      - name: Shellcheck installer
        run: shellcheck -s sh scripts/install.sh scripts/test/install_test.sh

      - name: Installer unit tests
        run: sh scripts/test/install_test.sh

      - name: PowerShell installer tests
        shell: pwsh
        run: pwsh -NoProfile -File scripts/test/install_ps_test.ps1
```

- [ ] **Step 4: Verify the workflow changes**

Validate the YAML parses and the steps landed where intended:

```bash
python3 -c "import yaml" 2>/dev/null \
  && python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['.github/workflows/release.yml','.github/workflows/deploy-docs.yml','.github/workflows/test.yml']]; print('yaml ok')" \
  || echo "PyYAML absent — install actionlint (brew install actionlint) and run: actionlint"
```
Expected: `yaml ok`. If PyYAML is not installed, run `actionlint` instead and expect no output — do not skip the check silently.

Reproduce the checksum step locally against the existing `dist/` output to prove the command and format are what `checksum_for` parses:

```bash
cd dist && sha256sum devdeck-runtime-* > /tmp/ck.txt 2>/dev/null || \
  { for f in *; do sha256sum "$f"; done > /tmp/ck.txt; }
head -2 /tmp/ck.txt
```
Expected: lines of `<64 hex>  <filename>`.

Then confirm `checksum_for` reads that real output:

```bash
DEVDECK_INSTALL_TEST=1 sh -c '. scripts/install.sh; checksum_for "$(ls dist | head -1)" < /tmp/ck.txt'
```
Expected: a 64-character hex digest.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml .github/workflows/deploy-docs.yml .github/workflows/test.yml
git commit -m "ci: publish install scripts and release checksums

Releases now carry checksums.txt, which the installers verify before
putting a binary on disk. deploy-docs copies scripts/install.* into the
Pages export so the one-liner URL is public even though the repo is not,
and test.yml lints and unit-tests the scripts on every push."
```

---

### Task 9: User-facing documentation

**Files:**
- Modify: `README.md:20-33` (Quick start)
- Modify: `COMMANDS.md` (after the "Hub / runtime roles" section)
- Modify: `TUTORIAL.md` (deployment-modes section)

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: nothing.

- [ ] **Step 1: Add the install section to README.md**

Insert immediately before the existing `## Quick start` heading:

```markdown
## Install

One command, no toolchain — downloads the release binary for your platform.

```bash
# Linux / macOS
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | GITHUB_TOKEN=ghp_xxx sh
```

```powershell
# Windows
$env:GITHUB_TOKEN="ghp_xxx"; irm https://kiyora.is-a.dev/devdeck/install.ps1 | iex
```

Add `DEVDECK_HUB_URL` and `DEVDECK_HUB_KEY` to the same command to register the
machine as a runtime against an existing hub in one step:

```bash
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | \
  GITHUB_TOKEN=ghp_xxx DEVDECK_HUB_URL=https://hub.ts.net DEVDECK_HUB_KEY=hubk sh
```

`GITHUB_TOKEN` is required because this repository is private — create a
fine-grained token with **Contents: read**. The scripts are served from the
public docs site, so you can read one before piping it. Full options:
[`scripts/README.md`](scripts/README.md).

> **Until the first release is published**, the Pages URL and the release assets
> do not exist yet. Fetch the script straight from the repo instead:
> `curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/ItsMyEyes/devdeck/main/scripts/install.sh | GITHUB_TOKEN=$GITHUB_TOKEN sh`
> Delete this note once `kiyora.is-a.dev/devdeck/install.sh` resolves.

Building from source instead:
```

That last line runs into the existing `## Quick start` content, so change the
existing heading from `## Quick start` to `### From source` and keep its body
unchanged.

- [ ] **Step 2: Add the installer reference to COMMANDS.md**

Append a section directly after the "Hub / runtime roles" section:

```markdown
## Installer scripts

`scripts/install.sh` (Linux/macOS) and `scripts/install.ps1` (Windows) download
a release binary and optionally register the machine as a runtime. They are
published to the public docs site by `.github/workflows/deploy-docs.yml`, so the
one-liner needs no credential to fetch the script — only the binary download is
authenticated.

```bash
# Install only
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | GITHUB_TOKEN=ghp_xxx sh

# Install, then self-register as a runtime and verify it reached the hub
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | \
  GITHUB_TOKEN=ghp_xxx DEVDECK_HUB_URL=https://hub.ts.net DEVDECK_HUB_KEY=hubk sh

# Pin a version, install somewhere else, write config without starting
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | \
  GITHUB_TOKEN=ghp_xxx DEVDECK_VERSION=v1.4.0 DEVDECK_INSTALL_DIR=/opt/devdeck \
  DEVDECK_NO_START=1 sh
```

Every variable is listed in [`scripts/README.md`](scripts/README.md). They are
the same `DEVDECK_*` names the server already reads, so the generated
`~/.config/devdeck/runtime.env` can be sourced directly.

No service is installed. A runtime started by the installer does not survive a
reboot; the script prints the command to start it again.

Run the script tests with `sh scripts/test/install_test.sh` and
`shellcheck -s sh scripts/install.sh`.
```

- [ ] **Step 3: Cross-link from TUTORIAL.md**

In `TUTORIAL.md`'s deployment-modes section (`## 13`), add a line at the top of the section body:

```markdown
> Adding a runtime machine to an existing hub is one command — see
> [Install](README.md#install). The rest of this section covers what the modes
> mean and how to configure them by hand.
```

- [ ] **Step 4: Verify the docs**

Check every relative link resolves and the fenced blocks are balanced:

```bash
grep -n "scripts/README.md" README.md COMMANDS.md
test -f scripts/README.md && echo "target exists"
awk '/^```/{n++} END{print "fences:", n, (n%2==0 ? "balanced" : "UNBALANCED")}' README.md
awk '/^```/{n++} END{print "fences:", n, (n%2==0 ? "balanced" : "UNBALANCED")}' COMMANDS.md
```
Expected: the grep finds the links, `target exists`, and both fence counts report `balanced`.

- [ ] **Step 5: Commit**

```bash
git add README.md COMMANDS.md TUTORIAL.md
git commit -m "docs: document the one-line installers

README leads with the install one-liner and demotes the source build to a
subsection; COMMANDS.md gets the full flag/env reference. Both carry the
temporary raw.githubusercontent fallback, to be deleted once the first
release publishes the Pages URL."
```

---

## Manual Verification

Automated tests cover the pure helpers. These paths involve the network, a real
filesystem, and a real hub, and are checked by hand.

**Blocked until a release exists.** `ItsMyEyes/devdeck` has zero published
releases and no tags on `origin`, so there is nothing to download. Cut one
first:

```bash
make tag VERSION=v1.4.0     # pushes the tag, triggers release.yml + deploy-docs.yml
gh run watch                # wait for both workflows
gh release view v1.4.0      # confirm devdeck-runtime-* and checksums.txt are attached
```

Then, on each platform:

1. **Install only** — `curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | GITHUB_TOKEN=$(gh auth token) sh`.
   Expect: detection line, `checksum verified`, `installed ~/.local/bin/devdeck`, a version line, and the "to register this machine" hint. Confirm `~/.local/bin/devdeck --version` matches the tag.
2. **Checksum enforcement** — re-run with a corrupted manifest (edit one digit in a local copy and point `DEVDECK_GITHUB_API` at a stub, or simply truncate the downloaded binary mid-run) and confirm it dies with `checksum mismatch` and installs nothing.
3. **Self-registration** — start a hub (`devdeck --role hub --key hubk --addr 0.0.0.0:9198`), then run the installer on a second machine with `DEVDECK_HUB_URL` and `DEVDECK_HUB_KEY` set. Expect `runtime is healthy` then `registered with the hub as '<hostname>'`, and the machine visible in the Machines UI.
4. **Re-run safety** — run the installer twice against the same hub. Expect `existing config backed up to ~/.config/devdeck/runtime.env.bak` and no duplicate machine entry.
5. **`DEVDECK_NO_START=1`** — expect the config file written, no process started, and the printed start command to work when pasted.
6. **Rosetta** — on Apple Silicon, run under `arch -x86_64 /bin/sh` and confirm it still installs `devdeck-runtime-darwin-arm64`.
7. **wget-only** — in a container without curl (`docker run --rm -it alpine sh`, `apk add wget`), confirm the wget branch downloads and installs.
8. **Windows** — run the PowerShell one-liner and the `install.cmd` shim on Windows 11, confirming both reach the same installed binary and that the PATH warning appears when `%LOCALAPPDATA%\DevDeck\bin` is not on PATH.

## Self-Review

**Spec coverage.** Every spec section maps to a task: interface and env contract → Tasks 2–7 and 9; detect → Task 2; resolve → Task 3; download/verify/install → Task 4; configure/start/confirm → Task 5; failure handling → Tasks 4–5; changes outside `scripts/` → Tasks 1, 8, 9; testing → Tasks 2–6 and 8; open risks → Task 9's temporary README note and the Manual Verification preamble.

**Naming consistency.** `asset_name` (sh), `Get-DevDeckAssetName` (ps1), and `selfupdate.AssetName` (Go) all produce `devdeck-runtime-<os>-<arch>[.exe]`; Task 1's test table, Task 2's test assertions, and Task 6's assertion table use the same six strings. `INSTALL_PATH`, `DD_ADDR`, `DD_KEY`, `DD_NAME`, `DD_HUB_URL`, `DD_HUB_KEY`, `DD_PUBLIC_URL`, and `DD_ROLE` are set in `register` (Task 5) before `write_config` and `start_runtime` read them.

**Known gap, deliberate.** Task 6 and Task 7 cannot be verified on macOS beyond `pwsh` availability; the cmd.exe shim needs a Windows host. The plan says to report that honestly rather than claim a passing run.
