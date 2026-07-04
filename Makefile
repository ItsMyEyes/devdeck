.PHONY: dev dev-web dev-api seed-clean build build-web prepare-webui build-api build-mcp portable portable-current portable-all typecheck lint vet test install clean

GOOS ?= $(shell go env GOOS)
GOARCH ?= $(shell go env GOARCH)
DIST_DIR := dist
WEBUI_DIR := backend/internal/webui/dist
WINDOWS_EXT := $(if $(filter windows,$(GOOS)),.exe,)
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X loom/backend/internal/version.Version=$(VERSION)

# ── Development ──────────────────────────────────────────────
# Start both frontend (Vite :5173) and backend (Go :8989)
dev:
	cd frontend && npm run dev

# Frontend only (Vite :5173)
dev-web:
	cd frontend && npm run dev:web

# Backend only (Go :8989)
dev-api:
	cd backend && go run ./cmd/server --db loom.db --open=false --env .env

# Delete the dev database (wipes seed/demo data used by `make dev-api`)
seed-clean:
	rm -f backend/loom.db backend/loom.db-wal backend/loom.db-shm

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

# ── Clean ────────────────────────────────────────────────────
clean:
	rm -f backend/loom-api
	rm -rf frontend/dist
	find $(WEBUI_DIR) -mindepth 1 ! -name .placeholder -exec rm -rf {} +
	rm -rf $(DIST_DIR)
