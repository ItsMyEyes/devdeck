package handler

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"

	"devdeck/backend/internal/store"
)

// MachineProxyHandler forwards /api/machines/{id}/proxy/{rest...} to the
// registered runtime, injecting the runtime's key server-side. It is the
// FALLBACK path — clients connect direct-first over the tailnet (see spec).
// httputil.ReverseProxy passes WebSocket upgrades through, so terminal and
// LSP sessions also work on this path.
type MachineProxyHandler struct {
	st *store.Store
}

func NewMachineProxyHandler(st *store.Store) *MachineProxyHandler {
	return &MachineProxyHandler{st: st}
}

func (h *MachineProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m, err := h.st.MachineByID(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	target, err := url.Parse(m.URL)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "invalid machine url")
		return
	}
	rest := r.PathValue("rest")

	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = target.Scheme
			pr.Out.URL.Host = target.Host
			pr.Out.URL.Path = "/" + rest
			q := pr.In.URL.Query()
			q.Del("key") // never forward the hub key to a runtime
			pr.Out.URL.RawQuery = q.Encode()
			// Hub credentials must not reach runtimes; the runtime key replaces them.
			pr.Out.Header.Del("Cookie")
			pr.Out.Header.Set("Authorization", "Bearer "+m.Key)
		},
		ModifyResponse: func(resp *http.Response) error {
			// The hub's CorsMiddleware sets these on the way out; forwarding
			// the runtime's copy would duplicate the header and break browsers.
			resp.Header.Del("Access-Control-Allow-Origin")
			resp.Header.Del("Access-Control-Allow-Methods")
			resp.Header.Del("Access-Control-Allow-Headers")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("machine proxy: %s %s: %v", m.ID, r.URL.Path, err)
			writeErr(w, http.StatusBadGateway, "machine unreachable")
		},
	}
	proxy.ServeHTTP(w, r)
}
