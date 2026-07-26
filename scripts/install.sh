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
