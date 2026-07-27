package handler

import (
	"net/http"

	"devdeck/backend/internal/detect"
)

// TailscaleStatusHandler answers whether this hub process is currently
// reachable on the operator's tailnet, so MachineDialog can decide what
// --hub-url to show when its own origin is a loopback address (desktop
// "Host locally" mode). See
// docs/superpowers/specs/2026-07-17-local-hub-tailscale-reachability-design.md.
type TailscaleStatusHandler struct {
	// tailscaleServeEnabled mirrors main.go's *tailscaleServe flag — even a
	// fully working Tailscale install doesn't help until this process is
	// restarted with --enable-tailscale-serve on.
	tailscaleServeEnabled bool
}

// NewTailscaleStatusHandler creates a tailscale-status handler.
func NewTailscaleStatusHandler(tailscaleServeEnabled bool) *TailscaleStatusHandler {
	return &TailscaleStatusHandler{tailscaleServeEnabled: tailscaleServeEnabled}
}

type tailscaleStatusResponse struct {
	Ready  bool   `json:"ready"`
	Reason string `json:"reason,omitempty"`
	URL    string `json:"url,omitempty"`
}

func (h *TailscaleStatusHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.tailscaleServeEnabled {
		writeJSON(w, http.StatusOK, tailscaleStatusResponse{Reason: "serve_disabled"})
		return
	}
	url, reason := detect.TailscaleSelfURLWith(resolveTailscale)
	if reason != "" {
		writeJSON(w, http.StatusOK, tailscaleStatusResponse{Reason: reason})
		return
	}
	writeJSON(w, http.StatusOK, tailscaleStatusResponse{Ready: true, URL: url})
}

// resolveTailscale is the CLI lookup handed to detect.TailscaleSelfURLWith.
// It's overridable in tests so the "not installed" branch doesn't depend on
// what's actually resolvable (PATH, fallback dirs, login shell, macOS app
// bundle) on the machine running the test suite. The URL derivation itself
// lives in internal/detect so the setup wizard shares one implementation.
var resolveTailscale = detect.ResolveTailscale
