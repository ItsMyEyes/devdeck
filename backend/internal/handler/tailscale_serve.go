package handler

import (
	"net/http"
)

// TailscaleServeHandler starts and stops this hub's `tailscale serve` child
// while the process runs.
//
// Exposure used to be decided once, at launch, from --enable-tailscale-serve.
// That left no recovery when the decision was wrong: the desktop shell derives
// that flag from a one-shot preflight which loses a race against a Tailscale
// daemon still starting up at login, and every subsequent restart re-ran the
// same losing probe. This endpoint is the way out — and the way to switch
// exposure off without also shutting the hub down.
type TailscaleServeHandler struct {
	ctl ServeController
	// hubPort reports the port this process actually bound. Serve always
	// fronts THAT port, never one supplied by the caller: a client-chosen
	// port would let this endpoint publish some unrelated local service to
	// the whole tailnet.
	hubPort func() string
}

func NewTailscaleServeHandler(ctl ServeController, hubPort func() string) *TailscaleServeHandler {
	return &TailscaleServeHandler{ctl: ctl, hubPort: hubPort}
}

type tailscaleServeRequest struct {
	Enabled bool `json:"enabled"`
}

func (h *TailscaleServeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req tailscaleServeRequest
	if _, err := decodeBody(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if !req.Enabled {
		if err := h.ctl.Stop(); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"serving": false})
		return
	}
	port := h.hubPort()
	if port == "" {
		writeErr(w, http.StatusConflict, "this hub has not finished binding a port yet")
		return
	}
	if err := h.ctl.Start(port); err != nil {
		// The tailscale CLI's own failures land here — a missing binary, a
		// logged-out node, a 443 listener that could not be cleared. Reported
		// rather than logged-and-swallowed so the operator sees the actual
		// reason instead of a toggle that silently springs back.
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"serving": true, "servePort": port})
}
