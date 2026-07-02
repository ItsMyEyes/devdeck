.PHONY: dev dev-web dev-api build build-web build-api typecheck lint vet install clean

# ── Development ──────────────────────────────────────────────
# Start both frontend (Vite :5173) and backend (Go :8989)
dev:
	cd frontend && npm run dev

# Frontend only (Vite :5173)
dev-web:
	cd frontend && npm run dev:web

# Backend only (Go :8989)
dev-api:
	cd backend && go run ./cmd/server

# ── Build ────────────────────────────────────────────────────
# Production build — both frontend and backend
build: build-web build-api

build-web:
	cd frontend && npm run build

build-api:
	cd backend && go build -o loom-api ./cmd/server

# ── Quality ──────────────────────────────────────────────────
# TypeScript type-check
typecheck:
	cd frontend && npm run typecheck

# Go vet
vet:
	cd backend && go vet ./...

# Run all checks
lint: typecheck vet

# ── Dependencies ─────────────────────────────────────────────
install:
	cd frontend && npm install

# ── Clean ────────────────────────────────────────────────────
clean:
	rm -f backend/loom-api
	rm -rf frontend/dist
