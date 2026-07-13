package netproxy

import (
	"crypto/subtle"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

var hopByHopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

// HTTPProxyHandler is a standard HTTP/HTTPS forward proxy: CONNECT
// tunnels the underlying TCP connection (HTTPS and anything else), and
// plain requests with an absolute-form URI are forwarded upstream and
// relayed back. When authKey is non-empty, callers must present it as
// the password of a Basic Proxy-Authorization header (any username).
type HTTPProxyHandler struct {
	authKey string
	client  *http.Client
}

func NewHTTPProxyHandler(authKey string) *HTTPProxyHandler {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil // this handler IS the proxy; never chain to another one
	return &HTTPProxyHandler{
		authKey: authKey,
		client: &http.Client{
			Transport: transport,
			// Redirects are the downstream client's concern; forward the 3xx as-is.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

func (h *HTTPProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.authKey != "" && !h.authorized(r) {
		w.Header().Set("Proxy-Authenticate", `Basic realm="loom-proxy"`)
		http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
		return
	}

	if r.Method == http.MethodConnect {
		h.handleConnect(w, r)
		return
	}
	h.handleForward(w, r)
}

func (h *HTTPProxyHandler) authorized(r *http.Request) bool {
	const prefix = "Basic "
	auth := r.Header.Get("Proxy-Authorization")
	if !strings.HasPrefix(auth, prefix) {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(auth, prefix))
	if err != nil {
		return false
	}
	_, password, ok := strings.Cut(string(decoded), ":")
	if !ok {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(password), []byte(h.authKey)) == 1
}

func (h *HTTPProxyHandler) handleConnect(w http.ResponseWriter, r *http.Request) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking not supported", http.StatusInternalServerError)
		return
	}
	upstream, err := net.DialTimeout("tcp", hostWithPort(r.Host, "443"), 10*time.Second)
	if err != nil {
		http.Error(w, "upstream unreachable", http.StatusBadGateway)
		return
	}
	defer upstream.Close()

	client, _, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close()

	if _, err := client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		return
	}
	relay(client, upstream)
}

func (h *HTTPProxyHandler) handleForward(w http.ResponseWriter, r *http.Request) {
	if !r.URL.IsAbs() {
		http.Error(w, "absolute-form request URI required", http.StatusBadRequest)
		return
	}

	outReq := r.Clone(r.Context())
	outReq.RequestURI = ""
	stripHopByHopHeaders(outReq.Header)

	resp, err := h.client.Do(outReq)
	if err != nil {
		http.Error(w, "upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	stripHopByHopHeaders(resp.Header)
	dst := w.Header()
	for key, values := range resp.Header {
		for _, value := range values {
			dst.Add(key, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func stripHopByHopHeaders(h http.Header) {
	if connection := h.Get("Connection"); connection != "" {
		for _, token := range strings.Split(connection, ",") {
			h.Del(strings.TrimSpace(token))
		}
	}
	for _, key := range hopByHopHeaders {
		h.Del(key)
	}
}

func hostWithPort(host, defaultPort string) string {
	if _, _, err := net.SplitHostPort(host); err == nil {
		return host
	}
	return net.JoinHostPort(host, defaultPort)
}
