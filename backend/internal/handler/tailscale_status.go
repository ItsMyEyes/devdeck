package handler

import (
	"net/http"
	"sync/atomic"

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
	// port is this process's actual bound listener port, set via SetPort
	// once main() knows it (":0" isn't resolved until the listener binds).
	// Empty until then, and read as "" by a fresh atomic.Value — never nil.
	port atomic.Value
}

// NewTailscaleStatusHandler creates a tailscale-status handler.
func NewTailscaleStatusHandler(tailscaleServeEnabled bool) *TailscaleStatusHandler {
	h := &TailscaleStatusHandler{tailscaleServeEnabled: tailscaleServeEnabled}
	h.port.Store("")
	return h
}

// SetPort records the port this process's hub listener bound to. Called
// once from main() after the listener is up. ServeHTTP uses it to catch a
// `tailscale serve` config pointed at some other, possibly dead, port — a
// stale mapping left by a prior or unrelated process still reports "logged
// into tailnet" just fine, so that check alone can't see this drift.
func (h *TailscaleStatusHandler) SetPort(port string) {
	h.port.Store(port)
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
	if want, _ := h.port.Load().(string); want != "" {
		if got, ok := resolveTailscaleServeTargetPort(resolveTailscale); ok && got != want {
			writeJSON(w, http.StatusOK, tailscaleStatusResponse{Reason: "serve_target_mismatch"})
			return
		}
	}
	writeJSON(w, http.StatusOK, tailscaleStatusResponse{Ready: true, URL: url})
}

// resolveTailscale is the CLI lookup handed to detect.TailscaleSelfURLWith
// and resolveTailscaleServeTargetPort. It's overridable in tests so the
// "not installed" branch doesn't depend on what's actually resolvable
// (PATH, fallback dirs, login shell, macOS app bundle) on the machine
// running the test suite. The URL derivation itself lives in internal/detect
// so the setup wizard shares one implementation.
var resolveTailscale = detect.ResolveTailscale

// resolveTailscaleServeTargetPort is detect.TailscaleServeTargetPort,
// overridable in tests for the same reason as resolveTailscale.
var resolveTailscaleServeTargetPort = detect.TailscaleServeTargetPort
