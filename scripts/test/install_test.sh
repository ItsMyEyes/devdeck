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

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
