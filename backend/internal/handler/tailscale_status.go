package handler

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"
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

type tailscaleSelfStatus struct {
	Self struct {
		DNSName string `json:"DNSName"`
	} `json:"Self"`
}

func (h *TailscaleStatusHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.tailscaleServeEnabled {
		writeJSON(w, http.StatusOK, tailscaleStatusResponse{Reason: "serve_disabled"})
		return
	}
	url, reason := tailscaleSelfURL()
	if reason != "" {
		writeJSON(w, http.StatusOK, tailscaleStatusResponse{Reason: reason})
		return
	}
	writeJSON(w, http.StatusOK, tailscaleStatusResponse{Ready: true, URL: url})
}

// tailscaleSelfURL runs `tailscale status --self --json` and derives this
// device's tailnet-reachable URL, mirroring
// frontend/src-tauri/src/tailscale.rs's parse_dns_name/public_url.
func tailscaleSelfURL() (url string, reason string) {
	bin, err := exec.LookPath("tailscale")
	if err != nil {
		return "", "not_installed"
	}
	out, err := exec.Command(bin, "status", "--self", "--json").Output()
	if err != nil {
		return "", "not_ready"
	}
	var status tailscaleSelfStatus
	if err := json.Unmarshal(out, &status); err != nil {
		return "", "not_ready"
	}
	dns := strings.TrimSuffix(status.Self.DNSName, ".")
	if dns == "" {
		return "", "not_ready"
	}
	return "https://" + dns, ""
}
