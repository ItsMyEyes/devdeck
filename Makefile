.PHONY: dev dev-web dev-api dev-hub dev-runtime free-ports seed-clean build build-web prepare-webui build-api portable portable-current portable-all typecheck lint vet test install clean tag prepare-sidecar sidecar-host dev-tauri dev-tauri-full e2e-tauri-smoke e2e-agent-chat

GOOS ?= $(shell go env GOOS)
GOARCH ?= $(shell go env GOARCH)
DIST_DIR := dist
WEBUI_DIR := backend/internal/webui/dist
WINDOWS_EXT := $(if $(filter windows,$(GOOS)),.exe,)
# `?=`, not `:=`, so CI can pass the release tag explicitly: `VERSION=v1.2.3 make …`.
# The desktop release job MUST do that. It stamps the tag into the tracked
# `frontend/src-tauri/tauri.conf.json` before building (the updater compares
# against that value), which makes the tree dirty — and `tauri build`'s
# beforeBuildCommand then runs `make prepare-sidecar` from inside that dirty
# tree. Left to `git describe --dirty`, every sidecar shipped inside a desktop
# bundle would be stamped `v1.2.3-dirty`, and `selfupdate.NeedsUpdate` sorts a
# prerelease below its release — so the bundled runtime would report an
# available update against its own tag, forever.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X devdeck/backend/internal/version.Version=$(VERSION)

# Shared dev hub bearer key: gives the hub started by `make dev`/`make
# dev-api` a --key, purely as an additional auth path alongside the
# existing session-cookie login (see CONTRACTS.md "Key auth") — it changes
# nothing about the web UI login flow. Only exists so `make dev-runtime`
# has something to self-register with. Override with e.g.
# `make dev-runtime DEV_HUB_KEY=...` (and matching for `dev`/`dev-api`) if
# you want a different value.
DEV_HUB_KEY ?= dev-hub-key

# Mac App Store Tailscale.app doesn't put `tailscale` on PATH; fall back to
# its bundled binary if a standalone install isn't found.
TAILSCALE := $(shell command -v tailscale 2>/dev/null || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)

# ── Development ──────────────────────────────────────────────
# Start both frontend (Vite :5173) and backend (Go :8989). Also registers
# port 5173 with `tailscale serve`, so the dev UI is reachable from another
# device on your tailnet (e.g. testing the terminal WS from a phone) at
# https://<this-machine>.<tailnet>.ts.net — see allowedHosts in vite.config.ts.
dev:
	$(TAILSCALE) serve --bg 5173
	cd frontend && DEVDECK_KEY=$(DEV_HUB_KEY) npm run dev

# Frontend only (Vite :5173)
dev-web:
	cd frontend && npm run dev:web

# Backend only (Go :8989). Runs as --role hub (the default) — add
# --role runtime --key <key> to run this as a runtime instead; see the
# "Hub / runtime roles" section in COMMANDS.md for the two-node example.
dev-api:
	cd backend && DEVDECK_KEY=$(DEV_HUB_KEY) go run ./cmd/server --db devdeck.db --open=false --env .env --secure-cookies=false

# Same as dev-api, but spells out --role hub --key explicitly instead of
# relying on the default role + DEVDECK_KEY env var — pairs by name with
# dev-runtime for a two-process hub+runtime dev setup. Same port/db as
# dev-api (:8989, devdeck.db), so don't run both at once.
dev-hub:
	cd backend && go run ./cmd/server --role hub --key $(DEV_HUB_KEY) --db devdeck.db --open=false --env .env --secure-cookies=false

# Second backend process (Go :9199), --role runtime, self-registering with
# the hub started by `make dev`/`make dev-api` on :8989 — no manual step in
# the Machines UI. Requires that hub to already be running. See "Hub /
# runtime roles" in COMMANDS.md and
# docs/superpowers/specs/2026-07-09-runtime-self-registration-design.md.
dev-runtime:
	cd backend && go run ./cmd/server --role runtime --key dev-runtime-key --addr 127.0.0.1:9199 --db runtime.db --open=false \
	  --hub-url http://127.0.0.1:8989 --hub-key $(DEV_HUB_KEY) --public-url http://127.0.0.1:9199 --name local-runtime

# Kill whatever's listening on the dev ports (stuck `make dev`/`make dev-runtime` from a previous run, etc).
free-ports:
	@lsof -ti:8989,5173,9199 2>/dev/null | xargs -r kill -TERM
	@sleep 1
	@lsof -ti:8989,5173,9199 2>/dev/null | xargs -r kill -KILL
	@sleep 1
	@if [ -z "$$(lsof -ti:8989,5173,9199 2>/dev/null)" ]; then echo "ports 8989, 5173 and 9199 are free"; else echo "still in use:"; lsof -i:8989,5173,9199; fi

# Delete the dev databases (wipes seed/demo data used by `make dev-api`,
# plus the `make dev-runtime` runtime db and its self-registered machine row)
seed-clean:
	rm -f backend/devdeck.db backend/devdeck.db-wal backend/devdeck.db-shm
	rm -f backend/runtime.db backend/runtime.db-wal backend/runtime.db-shm

# ── Build ────────────────────────────────────────────────────
# Production host build — UI is embedded in the Go binary.
build: build-api

build-web:
	cd frontend && npm run build

prepare-webui: build-web
	find $(WEBUI_DIR) -mindepth 1 ! -name .placeholder -exec rm -rf {} +
	cp -R frontend/dist/. $(WEBUI_DIR)/

build-api: prepare-webui
	cd backend && go build -ldflags "$(LDFLAGS)" -o devdeck-api ./cmd/server

# NOTE: there is deliberately no separate build target for the SSH chat helper
# an agent calls as `devdeck-ssh`. It is a subcommand of this same binary
# (`devdeck ssh-tool`, see internal/sshtoolcli), reached through a shim DevDeck
# writes into each SSH thread's workspace at session start — so every target
# below ships it for free, and there is nothing extra for an operator to
# install, sign, or keep version-matched.

# NOTE: no target for the issue-tracker MCP server either — it is
# `devdeck mcp-server` (internal/issuemcp), reached through the same binary every
# target below builds. An agent's .mcp.json points its `command` straight at
# that binary; see COMMANDS.md "MCP server (agent-facing issue tracker)".

# Portable binary for the selected GOOS/GOARCH (defaults to the host).
portable: portable-current

portable-current: prepare-webui
	mkdir -p $(DIST_DIR)
	cd backend && CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/devdeck-$(GOOS)-$(GOARCH)$(WINDOWS_EXT) ./cmd/server

# Release matrix: macOS, Linux, and Windows on Intel/AMD and ARM64. One artifact
# per target: the SSH chat helper an agent calls as `devdeck-ssh` is a
# subcommand of this binary, not a companion file, so there is no pairing to get
# wrong in a release.
portable-all: prepare-webui
	mkdir -p $(DIST_DIR)
	cd backend && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/devdeck-darwin-amd64 ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/devdeck-darwin-arm64 ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/devdeck-linux-amd64 ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/devdeck-linux-arm64 ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/devdeck-windows-amd64.exe ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/devdeck-windows-arm64.exe ./cmd/server

# ── Desktop (Tauri) ──────────────────────────────────────────
# Sidecar binaries for the desktop app, named by Rust target triple as
# tauri's externalBin convention requires. tauri-build FAILS if these are
# missing, so run sidecar-host before `tauri dev` / `cargo check`.
TAURI_BIN_DIR := frontend/src-tauri/binaries

prepare-sidecar: prepare-webui
	mkdir -p $(TAURI_BIN_DIR)
	cd backend && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(TAURI_BIN_DIR)/devdeck-server-aarch64-apple-darwin ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(TAURI_BIN_DIR)/devdeck-server-x86_64-pc-windows-msvc.exe ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(TAURI_BIN_DIR)/devdeck-server-x86_64-unknown-linux-gnu ./cmd/server

sidecar-host: prepare-webui
	mkdir -p $(TAURI_BIN_DIR)
	cd backend && CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(TAURI_BIN_DIR)/devdeck-server-$$(rustc --print host-tuple)$(WINDOWS_EXT) ./cmd/server

# Run the desktop app in dev mode: builds the host-triple sidecar, then
# `tauri dev` opens a native window against the Vite dev server (:5173) —
# beforeDevCommand in tauri.conf.json runs `npm run dev`, which also starts
# the Go backend (:8989) as --role both, so no separate `make dev`/`dev-api`
# is needed. Hot-reloads on frontend changes; rerun this target after Go/Rust
# changes. `setup()` in lib.rs skips the hub-mode/sidecar flow entirely here
# (cfg!(debug_assertions) is true) — use dev-tauri-full to exercise that.
dev-tauri:
	cd frontend && npm run tauri:dev

# Same as dev-tauri, but exercises the real desktop flow instead of hot-
# reloading to the Vite dev server: the hub-mode chooser (or saved choice),
# sidecar spawn/respawn loop, and Tailscale-backed remote-mode runtime — the
# same Rust code a production install runs (DEVDECK_TAURI_DEV_FULL=1 lets it
# past the debug_assertions guard in lib.rs), just still a debug build.
# tauri.dev-full.conf.json drops devUrl/beforeDevCommand and uses a separate
# `identifier`, so hub-mode.json/devdeck.db/runtime-key never touch a real
# installed app's data. --no-dev-server is REQUIRED (see tauri:dev-full in
# frontend/package.json): with devUrl unset, `tauri dev` would otherwise spin
# up its own built-in dev server (port 1430) for frontendDist and load the
# window from http://localhost:1430 — but lib.rs navigates the placeholder/
# choose/error pages via the devdeck://localhost custom protocol (APP_SCHEME
# in lib.rs, served from the embedded frontendDist by serve_bundled_asset),
# which that dev server doesn't back, so show_choose_screen would hit "asset
# not found: choose.html". --no-dev-server makes Tauri serve the embedded
# frontendDist (ui/) straight from the custom protocol the Rust code targets.
# No frontend HMR here — the sidecar serves whatever `prepare-webui` last
# built into backend/internal/webui/dist.
#
# Agent chat (frontend/src/features/agent-chat/enabled.ts) is an in-flight
# feature that defaults OFF in a `vite build` (import.meta.env.PROD is true) —
# and this target serves exactly that static build via --no-dev-server rather
# than the Vite dev server, so it inherits chat-off same as a real production
# install, even though it's still a debug binary. VITE_AGENT_CHAT=1 flips it
# on for this target specifically. It has to be set before `npm run
# tauri:dev-full`'s own `make sidecar-host` (-> prepare-webui -> `vite build`)
# runs, not passed to `tauri dev` itself — the flag is baked into the bundle
# at build time, dev-tauri's own `vite dev` path already shows chat without
# this (PROD is false there). Override with `make dev-tauri-full
# VITE_AGENT_CHAT=0` to exercise the feature-off path instead.
VITE_AGENT_CHAT ?= 1

dev-tauri-full:
	cd frontend && VITE_AGENT_CHAT=$(VITE_AGENT_CHAT) npm run tauri:dev-full

# Scripted smoke test for dev-tauri-full's real local-hub-mode flow (sidecar
# spawn -> health check -> machine registration -> clean process teardown)
# without a human clicking through the native window: builds a plain, non-
# watching debug binary (`tauri build --no-bundle --debug`, no file-watcher
# so the "asset not found: choose.html" `tauri dev` race can't happen)
# against a throwaway dev.kiyora.devdeck.e2e app identifier
# (tauri.e2e.conf.json) and pre-seeds hub-mode.json so the one-time choose-
# hub-mode screen is skipped. That screen stays a manual, one-glance check
# via `make dev-tauri-full` — this target deliberately does not cover it.
# Opt-in, not part of `test`/`lint` (needs a full Tauri/Cargo build and a
# real Go sidecar build); macOS only for now. See
# docs/superpowers/specs/2026-07-17-tauri-desktop-e2e-smoke-harness-design.md.
e2e-tauri-smoke:
	./frontend/src-tauri/scripts/e2e-smoke.sh

# Real-browser check of the agent-chat composer (mode/effort/context pills,
# session restarts, socket error path) against an isolated `--role both`
# server with a fake `claude` on PATH. Opt-in like the smoke above: needs Go,
# Node and Python Playwright with Chromium. See scripts/e2e-agent-chat/README.md.
e2e-agent-chat:
	python3 scripts/e2e-agent-chat/run.py

# ── Quality ──────────────────────────────────────────────────
# TypeScript type-check
typecheck:
	cd frontend && npm run typecheck

# Go vet
vet:
	cd backend && go vet ./...

# Run all checks
lint: typecheck vet

test:
	cd backend && go test ./...
	cd frontend && npm test

# ── Dependencies ─────────────────────────────────────────────
install:
	cd frontend && npm install

# ── Release ──────────────────────────────────────────────────
# Cut a release: creates an annotated semver tag and pushes it, which
# triggers .github/workflows/release.yml (test, portable-all + desktop
# builds, GH Release).
# Usage: make tag VERSION=v1.2.3
tag:
	@test -n "$(VERSION)" || (echo "Usage: make tag VERSION=v1.2.3"; exit 1)
	@echo "$(VERSION)" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$$' || (echo "VERSION must match vX.Y.Z, got '$(VERSION)'"; exit 1)
	git tag -a $(VERSION) -m "$(VERSION)"
	git push origin $(VERSION)

# ── Clean ────────────────────────────────────────────────────
clean:
	rm -f backend/devdeck-api
	rm -rf frontend/dist
	find $(WEBUI_DIR) -mindepth 1 ! -name .placeholder -exec rm -rf {} +
	rm -rf $(DIST_DIR)
