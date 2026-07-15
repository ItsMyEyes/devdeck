.PHONY: dev dev-web dev-api dev-hub dev-runtime free-ports seed-clean build build-web prepare-webui build-api build-mcp portable portable-current portable-all typecheck lint vet test install clean tag prepare-sidecar sidecar-host dev-tauri

GOOS ?= $(shell go env GOOS)
GOARCH ?= $(shell go env GOARCH)
DIST_DIR := dist
WEBUI_DIR := backend/internal/webui/dist
WINDOWS_EXT := $(if $(filter windows,$(GOOS)),.exe,)
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X loom/backend/internal/version.Version=$(VERSION)

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
	cd frontend && LOOM_KEY=$(DEV_HUB_KEY) npm run dev

# Frontend only (Vite :5173)
dev-web:
	cd frontend && npm run dev:web

# Backend only (Go :8989). Runs as --role hub (the default) — add
# --role runtime --key <key> to run this as a runtime instead; see the
# "Hub / runtime roles" section in COMMANDS.md for the two-node example.
dev-api:
	cd backend && LOOM_KEY=$(DEV_HUB_KEY) go run ./cmd/server --db loom.db --open=false --env .env --secure-cookies=false

# Same as dev-api, but spells out --role hub --key explicitly instead of
# relying on the default role + LOOM_KEY env var — pairs by name with
# dev-runtime for a two-process hub+runtime dev setup. Same port/db as
# dev-api (:8989, loom.db), so don't run both at once.
dev-hub:
	cd backend && go run ./cmd/server --role hub --key $(DEV_HUB_KEY) --db loom.db --open=false --env .env --secure-cookies=false

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
	rm -f backend/loom.db backend/loom.db-wal backend/loom.db-shm
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
	cd backend && go build -ldflags "$(LDFLAGS)" -o loom-api ./cmd/server

# MCP stdio server exposing the issue tracker to coding agents (list_projects,
# create_issue, upload_attachment, mark_issue_done). Reads the same --db file
# the main server uses.
build-mcp:
	cd backend && go build -o loom-mcp-server ./cmd/mcp-server

# Portable binary for the selected GOOS/GOARCH (defaults to the host).
portable: portable-current

portable-current: prepare-webui
	mkdir -p $(DIST_DIR)
	cd backend && CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/loom-$(GOOS)-$(GOARCH)$(WINDOWS_EXT) ./cmd/server

# Release matrix: macOS, Linux, and Windows on Intel/AMD and ARM64.
portable-all: prepare-webui
	mkdir -p $(DIST_DIR)
	cd backend && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/loom-darwin-amd64 ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/loom-darwin-arm64 ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/loom-linux-amd64 ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/loom-linux-arm64 ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/loom-windows-amd64.exe ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/loom-windows-arm64.exe ./cmd/server

# ── Desktop (Tauri) ──────────────────────────────────────────
# Sidecar binaries for the desktop app, named by Rust target triple as
# tauri's externalBin convention requires. tauri-build FAILS if these are
# missing, so run sidecar-host before `tauri dev` / `cargo check`.
TAURI_BIN_DIR := frontend/src-tauri/binaries

prepare-sidecar: prepare-webui
	mkdir -p $(TAURI_BIN_DIR)
	cd backend && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(TAURI_BIN_DIR)/loom-server-aarch64-apple-darwin ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(TAURI_BIN_DIR)/loom-server-x86_64-pc-windows-msvc.exe ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(TAURI_BIN_DIR)/loom-server-x86_64-unknown-linux-gnu ./cmd/server

sidecar-host: prepare-webui
	mkdir -p $(TAURI_BIN_DIR)
	cd backend && CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(TAURI_BIN_DIR)/loom-server-$$(rustc --print host-tuple)$(WINDOWS_EXT) ./cmd/server

# Run the desktop app in dev mode: builds the host-triple sidecar, then
# `tauri dev` opens a native window against the Vite dev server (:5173) —
# beforeDevCommand in tauri.conf.json runs `npm run dev`, which also starts
# the Go backend (:8989) as --role both, so no separate `make dev`/`dev-api`
# is needed. Hot-reloads on frontend changes; rerun this target after Go/Rust
# changes.
dev-tauri:
	cd frontend && LOOM_ROLE=both LOOM_KEY=$(DEV_HUB_KEY) npm run tauri:dev

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
	rm -f backend/loom-api
	rm -rf frontend/dist
	find $(WEBUI_DIR) -mindepth 1 ! -name .placeholder -exec rm -rf {} +
	rm -rf $(DIST_DIR)
