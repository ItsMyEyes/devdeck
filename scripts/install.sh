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

if [ "${DEVDECK_INSTALL_TEST:-0}" != "1" ]; then
	main "$@"
fi
