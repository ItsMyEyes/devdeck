package handler

import (
	"net/http"
	"sync/atomic"

	"devdeck/backend/internal/detect"
)

// ServeController is the subset of *tsserve.Controller the tailscale handlers
// need. An interface so tests can drive every state without spawning
// processes or depending on a tailscale install.
type ServeController interface {
	// Status reports whether a serve child is running, and the port it fronts.
	Status() (running bool, port string)
	Start(port string) error
	Stop() error
}

// TailscaleStatusHandler answers whether this hub process is currently
// reachable on the operator's tailnet, so MachineDialog can decide what
// --hub-url to show when its own origin is a loopback address (desktop
// "Host locally" mode). See
// docs/superpowers/specs/2026-07-17-local-hub-tailscale-reachability-design.md.
type TailscaleStatusHandler struct {
	// ctl owns the serve child. Exposure is a runtime state now, not the
	// launch-time flag it used to be — see internal/tsserve.
	ctl ServeController
	// port is this process's actual bound listener port, set via SetPort
	// once main() knows it (":0" isn't resolved until the listener binds).
	// Empty until then, and read as "" by a fresh atomic.Value — never nil.
	port atomic.Value
}

// NewTailscaleStatusHandler creates a tailscale-status handler.
func NewTailscaleStatusHandler(ctl ServeController) *TailscaleStatusHandler {
	h := &TailscaleStatusHandler{ctl: ctl}
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

// HubPort reports the bound listener port, for handlers that need to serve
// exactly what this process is listening on.
func (h *TailscaleStatusHandler) HubPort() string {
	p, _ := h.port.Load().(string)
	return p
}

type tailscaleStatusResponse struct {
	Ready  bool   `json:"ready"`
	Reason string `json:"reason,omitempty"`
	URL    string `json:"url,omitempty"`
	// Serving is true while a `tailscale serve` child is running.
	Serving bool `json:"serving"`
	// ServePort is the port that child fronts; empty when not serving.
	ServePort string `json:"servePort,omitempty"`
	// HubPort is the port this hub actually bound — which is NOT always the
	// one it asked for, so the UI must show this rather than assume 8989.
	HubPort string `json:"hubPort,omitempty"`
	// CanServe is true when Tailscale itself is usable, i.e. starting serve
	// is worth offering. False means the reason is not something a
	// start/stop toggle can fix.
	CanServe bool `json:"canServe"`
}

func (h *TailscaleStatusHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.resolve())
}

// resolve computes this hub's tailnet reachability. Factored out of
// ServeHTTP so ReachableURL (main.go's binding-push resolver) shares exactly
// the same decision instead of re-deriving it — a hub is only actually
// reachable at its tailnet URL when Tailscale is usable, `tailscale serve`
// is running, AND it targets this hub's own bound port; getting any of that
// wrong by re-implementing it a second time would silently disagree with
// what /api/tailscale-status already tells the operator.
func (h *TailscaleStatusHandler) resolve() tailscaleStatusResponse {
	hubPort := h.HubPort()
	running, servePort := h.ctl.Status()

	// Probe Tailscale FIRST, even when serve is off. Whether serve is running
	// cannot distinguish "Tailscale is unusable here" from "usable, just not
	// switched on", and those need opposite advice: only the second is fixed
	// by starting serve. Reporting the second for a machine where the CLI
	// isn't resolvable or the node is logged out sent operators into an
	// endless restart loop, since no restart changes either.
	url, reason := detect.TailscaleSelfURLWith(resolveTailscale)
	if reason != "" {
		return tailscaleStatusResponse{Reason: reason, HubPort: hubPort}
	}
	if !running {
		// Tailscale really is usable here; serve just isn't running.
		return tailscaleStatusResponse{Reason: "serve_disabled", HubPort: hubPort, CanServe: true}
	}
	if hubPort != "" {
		if got, ok := resolveTailscaleServeTargetPort(resolveTailscale); ok && got != hubPort {
			return tailscaleStatusResponse{
				Reason: "serve_target_mismatch", Serving: true, ServePort: servePort,
				HubPort: hubPort, CanServe: true,
			}
		}
	}
	return tailscaleStatusResponse{
		Ready: true, URL: url, Serving: true, ServePort: servePort,
		HubPort: hubPort, CanServe: true,
	}
}

// ReachableURL reports this hub's tailnet URL when a remote machine can
// actually reach it right now, and "" with a reason otherwise. Used as the
// service.HubURLResolver behind RunBindingPushLoop: a hub only pushes its
// identity to a registered machine when it has a real answer to "what
// address should that machine use to reach me back".
func (h *TailscaleStatusHandler) ReachableURL() (url string, ok bool, reason string) {
	resp := h.resolve()
	if resp.Ready {
		return resp.URL, true, ""
	}
	return "", false, resp.Reason
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
