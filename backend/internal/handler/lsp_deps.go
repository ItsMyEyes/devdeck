package handler

import (
	"net/http"

	"devdeck/backend/internal/lsp"
)

// LspDepsHandler reports which language servers and toolchains are present on
// this machine, and installs the missing ones on request.
//
// It answers a question the editor could otherwise only hint at: a language
// server that is installed but cannot reach its own toolchain does not fail
// loudly, it degrades. Surfacing the resolved paths and the PATH the server is
// spawned with turns that into something an operator can see.
//
// Machine-scoped by virtue of where it runs: the hub reaches a runtime's copy
// through /api/machines/{id}/proxy/, so each machine reports its own tools.
type LspDepsHandler struct {
	installer *lsp.Installer
}

func NewLspDepsHandler(installer *lsp.Installer) *LspDepsHandler {
	return &LspDepsHandler{installer: installer}
}

// GetDeps answers with the full dependency report. Read-only: probing never
// installs anything.
func (h *LspDepsHandler) GetDeps(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, lsp.Report())
}

type installDepRequest struct {
	Binary string `json:"binary"`
}

// PostInstall installs one language server, then answers with a fresh report
// so the caller can render the new state without a second round trip.
//
// Synchronous by design: `go install` and `npm install -g` take tens of
// seconds, and the Installer already deduplicates concurrent requests for the
// same binary, so two operators clicking Install at once share one install
// rather than racing.
func (h *LspDepsHandler) PostInstall(w http.ResponseWriter, r *http.Request) {
	var body installDepRequest
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// Guard the exec: only binaries this package manages may be named, so a
	// request body can never steer the installer at an arbitrary command.
	if !lsp.KnownBinary(body.Binary) {
		writeErr(w, http.StatusBadRequest, "unknown language server")
		return
	}
	if err := h.installer.InstallBinary(r.Context(), body.Binary); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, lsp.Report())
}
