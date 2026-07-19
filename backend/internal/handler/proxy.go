package handler

import (
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
