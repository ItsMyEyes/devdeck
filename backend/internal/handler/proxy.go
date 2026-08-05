package handler

import (
	"encoding/json"
	"net/http"

	"devdeck/backend/internal/service"
)

// ProxyHandler exposes ProxyService's on-demand SOCKS5/HTTP forward proxy
// over HTTP, for the desktop app's machine-proxied Browser tab to call
// before pointing a native webview's proxy_url at the result.
type ProxyHandler struct {
	svc *service.ProxyService
}

func NewProxyHandler(svc *service.ProxyService) *ProxyHandler {
	return &ProxyHandler{svc: svc}
}

// PostStart idempotently starts this machine's forward proxy pair. A second
// call while already running returns the existing bound addresses/key.
func (h *ProxyHandler) PostStart(w http.ResponseWriter, r *http.Request) {
	result, err := h.svc.Start()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"socks5Addr":    result.SOCKS5Addr,
		"httpProxyAddr": result.HTTPProxyAddr,
	})
}

// PublishedSOCKSHandler exposes this machine's persistent, key-authenticated
// SOCKS5 publication over HTTP. Registered on every role — a runtime
// publishing a proxy is the primary use case, so unlike most hub routes this
// one is deliberately not gated on the role.
type PublishedSOCKSHandler struct {
	svc *service.PublishedSOCKSService
}

func NewPublishedSOCKSHandler(svc *service.PublishedSOCKSService) *PublishedSOCKSHandler {
	return &PublishedSOCKSHandler{svc: svc}
}

// Get reports stored intent plus current liveness.
func (h *PublishedSOCKSHandler) Get(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	status, err := h.svc.Status()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// publishedSOCKSRequest is the PUT body. Port 0 means "keep the stored port".
type publishedSOCKSRequest struct {
	Enabled   bool `json:"enabled"`
	Port      int  `json:"port"`
	RotateKey bool `json:"rotateKey"`
}

// Put applies the requested state live and persists it.
func (h *PublishedSOCKSHandler) Put(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body publishedSOCKSRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	status, err := h.svc.Apply(body.Enabled, body.Port, body.RotateKey)
	if err != nil {
		// A bind conflict or an out-of-range port is the caller's problem,
		// not a server fault — and must never take the process down.
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, status)
}
