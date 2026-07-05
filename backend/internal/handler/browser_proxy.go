package handler

import (
	"fmt"
	"html"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	browserProxyPath     = "/api/browser/proxy"
	maxBrowserTextBytes  = 15 << 20 // 15MB is enough for HTML/CSS documents; binaries stream.
	browserUserAgent     = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) LoomBrowser/1.0 Safari/537.36"
	browserProxyCSP      = "sandbox allow-downloads allow-forms allow-modals allow-popups allow-scripts"
	browserProxyReferrer = "no-referrer"
)

var (
	htmlURLAttrPattern = regexp.MustCompile(`(?is)\b(href|src|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^'" >]+))`)
	htmlSrcsetPattern  = regexp.MustCompile(`(?is)\bsrcset\s*=\s*("([^"]*)"|'([^']*)')`)
	cssURLPattern      = regexp.MustCompile(`(?is)url\(\s*(['"]?)([^'")]+)['"]?\s*\)`)
	cssImportPattern   = regexp.MustCompile(`(?is)@import\s+(['"])([^'"]+)['"]`)
)

// BrowserProxyHandler fetches web pages from the server's network and serves
// them back through Loom. The frontend renders this endpoint inside a sandboxed
// iframe, so untrusted pages do not run in the same origin as the app UI.
type BrowserProxyHandler struct {
	client *http.Client
}

// NewBrowserProxyHandler creates the server-network browser proxy.
func NewBrowserProxyHandler() *BrowserProxyHandler {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 20 * time.Second
	transport.IdleConnTimeout = 90 * time.Second
	transport.TLSHandshakeTimeout = 10 * time.Second
	return &BrowserProxyHandler{client: &http.Client{Transport: transport}}
}

// Proxy relays a single HTTP(S) request through the Loom server. GET/HEAD cover
// normal page/resource loads, and POST supports basic form submissions.
func (h *BrowserProxyHandler) Proxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	target, err := normalizeBrowserURL(r.URL.Query().Get("url"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	var body io.Reader
	if r.Method == http.MethodPost {
		body = http.MaxBytesReader(w, r.Body, 8<<20)
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid url")
		return
	}
	copyBrowserRequestHeaders(req.Header, r.Header)

	client := h.client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "browser proxy fetch failed")
		return
	}
	defer resp.Body.Close()

	contentType := resp.Header.Get("Content-Type")
	mediaType, _, _ := mime.ParseMediaType(contentType)
	base := resp.Request.URL

	switch strings.ToLower(mediaType) {
	case "text/html", "application/xhtml+xml":
		data, err := readBrowserText(resp.Body)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		out := []byte(rewriteBrowserHTML(string(data), base))
		writeBrowserResponseHeaders(w.Header(), resp.Header, "text/html; charset=utf-8", len(out), true, base.String())
		writeBrowserStatus(w, resp.StatusCode)
		if r.Method != http.MethodHead {
			_, _ = w.Write(out)
		}
	case "text/css":
		data, err := readBrowserText(resp.Body)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		out := []byte(rewriteBrowserCSS(string(data), base))
		writeBrowserResponseHeaders(w.Header(), resp.Header, "text/css; charset=utf-8", len(out), false, base.String())
		writeBrowserStatus(w, resp.StatusCode)
		if r.Method != http.MethodHead {
			_, _ = w.Write(out)
		}
	default:
		writeBrowserResponseHeaders(w.Header(), resp.Header, contentType, -1, false, base.String())
		writeBrowserStatus(w, resp.StatusCode)
		if r.Method != http.MethodHead {
			_, _ = io.Copy(w, resp.Body)
		}
	}
}

func normalizeBrowserURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("url is required")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("invalid url")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("only http and https urls are supported")
	}
	u.Fragment = ""
	return u, nil
}

func copyBrowserRequestHeaders(dst, src http.Header) {
	dst.Set("User-Agent", browserUserAgent)
	if accept := src.Get("Accept"); accept != "" {
		dst.Set("Accept", accept)
	} else {
		dst.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	}
	if lang := src.Get("Accept-Language"); lang != "" {
		dst.Set("Accept-Language", lang)
	}
	if rng := src.Get("Range"); rng != "" {
		dst.Set("Range", rng)
	}
	if ct := src.Get("Content-Type"); ct != "" {
		dst.Set("Content-Type", ct)
	}
}

func readBrowserText(r io.Reader) ([]byte, error) {
	limited := io.LimitReader(r, maxBrowserTextBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(data) > maxBrowserTextBytes {
		return nil, fmt.Errorf("proxied document is too large")
	}
	return data, nil
}

func writeBrowserStatus(w http.ResponseWriter, upstreamStatus int) {
	if upstreamStatus >= http.StatusBadRequest {
		// JSONErrorMiddleware rewrites >=400 /api responses into JSON envelopes.
		// Keep upstream error pages renderable inside the browser iframe.
		w.Header().Set("X-Loom-Browser-Upstream-Status", strconv.Itoa(upstreamStatus))
		w.WriteHeader(http.StatusOK)
		return
	}
	w.WriteHeader(upstreamStatus)
}

func writeBrowserResponseHeaders(dst, src http.Header, contentType string, contentLength int, document bool, finalURL string) {
	for key, values := range src {
		if skipBrowserHeader(key) {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
	if contentType != "" {
		dst.Set("Content-Type", contentType)
	}
	if contentLength >= 0 {
		dst.Set("Content-Length", strconv.Itoa(contentLength))
	} else {
		dst.Del("Content-Length")
	}
	dst.Set("Referrer-Policy", browserProxyReferrer)
	dst.Set("X-Loom-Browser-URL", finalURL)
	dst.Set("X-Robots-Tag", "noindex")
	if document {
		dst.Set("Content-Security-Policy", browserProxyCSP)
	}
}

func skipBrowserHeader(key string) bool {
	switch strings.ToLower(key) {
	case "connection",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
		"content-security-policy",
		"content-security-policy-report-only",
		"x-frame-options",
		"set-cookie",
		"set-cookie2",
		"clear-site-data",
		"cross-origin-opener-policy",
		"cross-origin-embedder-policy",
		"cross-origin-resource-policy",
		"permissions-policy":
		return true
	default:
		return false
	}
}

func rewriteBrowserHTML(doc string, base *url.URL) string {
	doc = htmlURLAttrPattern.ReplaceAllStringFunc(doc, func(match string) string {
		parts := htmlURLAttrPattern.FindStringSubmatch(match)
		if len(parts) == 0 {
			return match
		}
		value := firstNonEmpty(parts[3], parts[4], parts[5])
		rewritten := rewriteBrowserURL(value, base)
		if rewritten == value {
			return match
		}
		return fmt.Sprintf(`%s="%s"`, parts[1], html.EscapeString(rewritten))
	})
	doc = htmlSrcsetPattern.ReplaceAllStringFunc(doc, func(match string) string {
		parts := htmlSrcsetPattern.FindStringSubmatch(match)
		if len(parts) == 0 {
			return match
		}
		value := firstNonEmpty(parts[2], parts[3])
		rewritten := rewriteBrowserSrcset(value, base)
		if rewritten == value {
			return match
		}
		return fmt.Sprintf(`srcset="%s"`, html.EscapeString(rewritten))
	})
	return injectBrowserNavigationScript(doc, base)
}

func rewriteBrowserCSS(css string, base *url.URL) string {
	css = cssURLPattern.ReplaceAllStringFunc(css, func(match string) string {
		parts := cssURLPattern.FindStringSubmatch(match)
		if len(parts) < 3 {
			return match
		}
		rewritten := rewriteBrowserURL(strings.TrimSpace(parts[2]), base)
		if rewritten == parts[2] {
			return match
		}
		return "url(" + strconv.Quote(rewritten) + ")"
	})
	return cssImportPattern.ReplaceAllStringFunc(css, func(match string) string {
		parts := cssImportPattern.FindStringSubmatch(match)
		if len(parts) < 3 {
			return match
		}
		rewritten := rewriteBrowserURL(parts[2], base)
		if rewritten == parts[2] {
			return match
		}
		return "@import " + strconv.Quote(rewritten)
	})
}

func rewriteBrowserSrcset(srcset string, base *url.URL) string {
	items := strings.Split(srcset, ",")
	for i, item := range items {
		fields := strings.Fields(strings.TrimSpace(item))
		if len(fields) == 0 {
			continue
		}
		fields[0] = rewriteBrowserURL(fields[0], base)
		items[i] = strings.Join(fields, " ")
	}
	return strings.Join(items, ", ")
}

func rewriteBrowserURL(raw string, base *url.URL) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.HasPrefix(raw, "#") || strings.HasPrefix(raw, browserProxyPath+"?") {
		return raw
	}
	lower := strings.ToLower(raw)
	for _, prefix := range []string{"javascript:", "mailto:", "tel:", "data:", "blob:", "about:"} {
		if strings.HasPrefix(lower, prefix) {
			return raw
		}
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	target := base.ResolveReference(parsed)
	if target.Scheme != "http" && target.Scheme != "https" {
		return raw
	}
	target.Fragment = ""
	return browserProxyPath + "?url=" + url.QueryEscape(target.String())
}

func injectBrowserNavigationScript(doc string, base *url.URL) string {
	script := `<script>
(() => {
  const baseURL = ` + strconv.Quote(base.String()) + `;
  const proxyPath = ` + strconv.Quote(browserProxyPath) + `;
  const notify = (url) => {
    try {
      window.parent.postMessage({ type: "loom-browser:navigate", url }, "*");
    } catch {}
  };
  const targetURL = (raw) => {
    if (!raw || raw.startsWith("#")) return "";
    if (raw.startsWith(proxyPath + "?")) {
      try {
        return new URL(raw, window.location.origin).searchParams.get("url") || "";
      } catch {
        return "";
      }
    }
    try {
      const target = new URL(raw, baseURL);
      if (target.protocol !== "http:" && target.protocol !== "https:") return "";
      target.hash = "";
      return target.href;
    } catch {
      return "";
    }
  };
  const proxy = (url) => proxyPath + "?url=" + encodeURIComponent(url);
  document.addEventListener("click", (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) return;
    const target = targetURL(href);
    if (!target) return;
    event.preventDefault();
    notify(target);
    window.location.href = proxy(target);
  }, true);
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form || form.tagName !== "FORM") return;
    const method = (form.getAttribute("method") || "GET").toUpperCase();
    const action = form.getAttribute("action") || baseURL;
    if (method === "GET") {
      event.preventDefault();
      try {
        const target = new URL(action, baseURL);
        new FormData(form).forEach((value, key) => target.searchParams.append(key, String(value)));
        target.hash = "";
        notify(target.href);
        window.location.href = proxy(target.href);
      } catch {}
      return;
    }
    const target = targetURL(action);
    if (target) {
      notify(target);
      form.action = proxy(target);
    }
  }, true);
})();
</script>`
	lower := strings.ToLower(doc)
	if idx := strings.Index(lower, "</head>"); idx >= 0 {
		return doc[:idx] + script + doc[idx:]
	}
	return script + doc
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
