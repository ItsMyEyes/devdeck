package handler

import (
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	xhtml "golang.org/x/net/html"
	"devdeck/backend/internal/service"
)

const (
	browserProxyPath     = "/api/browser/proxy"
	maxBrowserTextBytes  = 15 << 20 // 15MB is enough for HTML/CSS documents; binaries stream.
	browserUserAgent     = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
	browserProxyCSP      = "sandbox allow-downloads allow-forms allow-modals allow-popups allow-scripts"
	browserProxyReferrer = "no-referrer"
)

var (
	cssURLPattern    = regexp.MustCompile(`(?is)url\(\s*(['"]?)([^'")]+)['"]?\s*\)`)
	cssImportPattern = regexp.MustCompile(`(?is)@import\s+(['"])([^'"]+)['"]`)
)

// BrowserProxyHandler fetches web pages from the server's network and serves
// them back through DevDeck. The frontend renders this endpoint inside a sandboxed
// iframe, so untrusted pages do not run in the same origin as the app UI.
type BrowserProxyHandler struct {
	client *http.Client
	svc    *service.AuthService
	jarMu  sync.Mutex
	jars   map[string]browserProxyJar
}

type browserProxyJar struct {
	jar     http.CookieJar
	expires time.Time
}

// NewBrowserProxyHandler creates the server-network browser proxy.
func NewBrowserProxyHandler(svc *service.AuthService) *BrowserProxyHandler {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 20 * time.Second
	transport.IdleConnTimeout = 90 * time.Second
	transport.TLSHandshakeTimeout = 10 * time.Second
	return &BrowserProxyHandler{client: &http.Client{Transport: transport}, svc: svc}
}

// GetSession issues a scoped token used by sandboxed iframe proxy requests.
func (h *BrowserProxyHandler) GetSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if h.svc == nil {
		writeErr(w, http.StatusInternalServerError, "browser proxy auth unavailable")
		return
	}
	token, err := h.svc.IssueBrowserProxyToken(cookieValue(r, sessionCookieName))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

// Proxy relays a single HTTP(S) request through the DevDeck server. GET/HEAD cover
// normal page/resource loads, and POST supports basic form submissions.
func (h *BrowserProxyHandler) Proxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	proxyToken := r.URL.Query().Get("token")
	if h.svc != nil {
		if err := h.svc.ValidateBrowserProxyToken(proxyToken); err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
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
	copyBrowserRequestHeaders(req.Header, r.Header, r.Method, target)

	client := h.clientForProxyToken(proxyToken)
	resp, err := client.Do(req)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "browser proxy fetch failed")
		return
	}
	defer resp.Body.Close()

	contentType := resp.Header.Get("Content-Type")
	mediaType, _, _ := mime.ParseMediaType(contentType)
	base := resp.Request.URL
	resourceKind := browserResourceKind(target, r.Header.Get("Sec-Fetch-Dest"))

	if strings.EqualFold(mediaType, "text/html") && writeBrowserResourceMismatch(w, resp, target, resourceKind, base.String(), r.Method) {
		return
	}

	switch strings.ToLower(mediaType) {
	case "text/html", "application/xhtml+xml":
		data, err := readBrowserText(resp.Body)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		out := []byte(rewriteBrowserHTML(string(data), base, proxyToken))
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
		out := []byte(rewriteBrowserCSS(string(data), base, proxyToken))
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

func (h *BrowserProxyHandler) clientForProxyToken(proxyToken string) *http.Client {
	base := h.client
	if base == nil {
		base = http.DefaultClient
	}
	if proxyToken == "" {
		return base
	}

	jar := h.cookieJarForProxyToken(proxyToken)
	client := *base
	client.Jar = jar
	return &client
}

func (h *BrowserProxyHandler) cookieJarForProxyToken(proxyToken string) http.CookieJar {
	h.jarMu.Lock()
	defer h.jarMu.Unlock()

	now := time.Now()
	if h.jars == nil {
		h.jars = make(map[string]browserProxyJar)
	}
	for token, session := range h.jars {
		if !session.expires.After(now) {
			delete(h.jars, token)
		}
	}
	if session, ok := h.jars[proxyToken]; ok {
		session.expires = browserProxyJarExpiry(proxyToken, now)
		h.jars[proxyToken] = session
		return session.jar
	}

	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil
	}
	h.jars[proxyToken] = browserProxyJar{
		jar:     jar,
		expires: browserProxyJarExpiry(proxyToken, now),
	}
	return jar
}

func browserProxyJarExpiry(proxyToken string, now time.Time) time.Time {
	parts := strings.Split(proxyToken, ".")
	if len(parts) == 3 {
		if expiresAt, err := strconv.ParseInt(parts[0], 10, 64); err == nil {
			expires := time.Unix(expiresAt, 0).Add(time.Minute)
			if expires.After(now) {
				return expires
			}
		}
	}
	return now.Add(time.Hour)
}

func copyBrowserRequestHeaders(dst, src http.Header, method string, target *url.URL) {
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
	for _, key := range []string{"Sec-CH-UA", "Sec-CH-UA-Mobile", "Sec-CH-UA-Platform"} {
		if value := src.Get(key); value != "" {
			dst.Set(key, value)
		}
	}

	dest := browserFetchDest(src.Get("Sec-Fetch-Dest"))
	dst.Set("Sec-Fetch-Dest", dest)
	dst.Set("Sec-Fetch-Mode", browserFetchMode(dest, src.Get("Sec-Fetch-Mode")))
	if dest == "document" {
		dst.Set("Sec-Fetch-Site", "none")
		dst.Set("Upgrade-Insecure-Requests", "1")
	} else {
		dst.Set("Sec-Fetch-Site", "same-origin")
		dst.Set("Referer", browserOriginReferrer(target))
	}
	if method != http.MethodGet && method != http.MethodHead {
		dst.Set("Origin", strings.TrimSuffix(browserOriginReferrer(target), "/"))
	}
}

func browserFetchDest(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "audio", "document", "embed", "empty", "font", "frame", "iframe", "image", "manifest", "object", "script", "serviceworker", "sharedworker", "style", "track", "video", "worker", "xslt":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "document"
	}
}

func browserFetchMode(dest, value string) string {
	switch dest {
	case "document", "frame", "iframe":
		return "navigate"
	}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "cors", "no-cors", "same-origin":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		if dest == "empty" {
			return "cors"
		}
		return "no-cors"
	}
}

func browserOriginReferrer(u *url.URL) string {
	if u == nil {
		return ""
	}
	return u.Scheme + "://" + u.Host + "/"
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
		w.Header().Set("X-DevDeck-Browser-Upstream-Status", strconv.Itoa(upstreamStatus))
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
	dst.Set("X-DevDeck-Browser-URL", finalURL)
	dst.Set("X-Robots-Tag", "noindex")
	dst.Set("Access-Control-Allow-Origin", "*")
	if document {
		dst.Set("Content-Security-Policy", browserProxyCSP)
	}
}

func browserResourceKind(target *url.URL, fetchDest string) string {
	switch browserFetchDest(fetchDest) {
	case "script", "serviceworker", "sharedworker", "worker":
		return "script"
	case "style":
		return "style"
	}
	if target == nil {
		return ""
	}
	switch strings.ToLower(path.Ext(target.Path)) {
	case ".js", ".mjs":
		return "script"
	case ".css":
		return "style"
	default:
		return ""
	}
}

func writeBrowserResourceMismatch(w http.ResponseWriter, resp *http.Response, target *url.URL, resourceKind, finalURL, method string) bool {
	if resourceKind == "" {
		return false
	}

	var contentType, body string
	switch resourceKind {
	case "script":
		contentType = "application/javascript; charset=utf-8"
		body = "console.error(" + strconv.Quote("DevDeck browser proxy: upstream returned HTML for script "+target.String()+". The site may be serving a login/challenge page or a missing asset fallback.") + ");\n"
	case "style":
		contentType = "text/css; charset=utf-8"
		body = "/* DevDeck browser proxy: upstream returned HTML for stylesheet " + strings.ReplaceAll(target.String(), "*/", "* /") + ". */\n"
	default:
		return false
	}

	out := []byte(body)
	writeBrowserResponseHeaders(w.Header(), resp.Header, contentType, len(out), false, finalURL)
	w.Header().Set("X-DevDeck-Browser-Content-Mismatch", resourceKind+"-was-html")
	writeBrowserStatus(w, resp.StatusCode)
	if method != http.MethodHead {
		_, _ = w.Write(out)
	}
	return true
}

func skipBrowserHeader(key string) bool {
	lower := strings.ToLower(key)
	if strings.HasPrefix(lower, "access-control-") {
		return true
	}
	switch lower {
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

func rewriteBrowserHTML(doc string, base *url.URL, proxyToken string) string {
	root, err := xhtml.Parse(strings.NewReader(doc))
	if err != nil {
		return injectBrowserNavigationScript(doc, base, proxyToken)
	}
	effectiveBase := browserDocumentBase(root, base)
	rewriteBrowserHTMLNode(root, effectiveBase, proxyToken)
	injectBrowserNavigationScriptNode(root, browserNavigationScript(effectiveBase, proxyToken))

	var out strings.Builder
	if err := xhtml.Render(&out, root); err != nil {
		return injectBrowserNavigationScript(doc, base, proxyToken)
	}
	return out.String()
}

func rewriteBrowserHTMLNode(n *xhtml.Node, base *url.URL, proxyToken string) {
	if n.Type == xhtml.ElementNode {
		isBase := strings.EqualFold(n.Data, "base")
		for i := range n.Attr {
			switch strings.ToLower(n.Attr[i].Key) {
			case "href":
				if isBase {
					if base != nil {
						n.Attr[i].Val = base.String()
					}
					continue
				}
				n.Attr[i].Val = rewriteBrowserURL(n.Attr[i].Val, base, proxyToken)
			case "src", "poster":
				n.Attr[i].Val = rewriteBrowserURL(n.Attr[i].Val, base, proxyToken)
			case "srcset":
				n.Attr[i].Val = rewriteBrowserSrcset(n.Attr[i].Val, base, proxyToken)
			}
		}
	}
	for child := n.FirstChild; child != nil; child = child.NextSibling {
		rewriteBrowserHTMLNode(child, base, proxyToken)
	}
}

func browserDocumentBase(root *xhtml.Node, fallback *url.URL) *url.URL {
	if fallback == nil {
		return nil
	}
	if href := firstBrowserBaseHref(root); href != "" {
		if parsed, err := url.Parse(href); err == nil {
			base := fallback.ResolveReference(parsed)
			if base.Scheme == "http" || base.Scheme == "https" {
				base.Fragment = ""
				return base
			}
		}
	}
	return fallback
}

func firstBrowserBaseHref(n *xhtml.Node) string {
	if n == nil {
		return ""
	}
	if n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "base") {
		for _, attr := range n.Attr {
			if strings.EqualFold(attr.Key, "href") {
				return strings.TrimSpace(attr.Val)
			}
		}
	}
	for child := n.FirstChild; child != nil; child = child.NextSibling {
		if href := firstBrowserBaseHref(child); href != "" {
			return href
		}
	}
	return ""
}

func rewriteBrowserCSS(css string, base *url.URL, proxyToken string) string {
	css = cssURLPattern.ReplaceAllStringFunc(css, func(match string) string {
		parts := cssURLPattern.FindStringSubmatch(match)
		if len(parts) < 3 {
			return match
		}
		rewritten := rewriteBrowserURL(strings.TrimSpace(parts[2]), base, proxyToken)
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
		rewritten := rewriteBrowserURL(parts[2], base, proxyToken)
		if rewritten == parts[2] {
			return match
		}
		return "@import " + strconv.Quote(rewritten)
	})
}

func rewriteBrowserSrcset(srcset string, base *url.URL, proxyToken string) string {
	items := strings.Split(srcset, ",")
	for i, item := range items {
		fields := strings.Fields(strings.TrimSpace(item))
		if len(fields) == 0 {
			continue
		}
		fields[0] = rewriteBrowserURL(fields[0], base, proxyToken)
		items[i] = strings.Join(fields, " ")
	}
	return strings.Join(items, ", ")
}

func rewriteBrowserURL(raw string, base *url.URL, proxyToken string) string {
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
	return browserProxyURL(target.String(), proxyToken)
}

func browserProxyURL(targetURL, proxyToken string) string {
	values := url.Values{}
	values.Set("url", targetURL)
	if proxyToken != "" {
		values.Set("token", proxyToken)
	}
	return browserProxyPath + "?" + values.Encode()
}

func injectBrowserNavigationScript(doc string, base *url.URL, proxyToken string) string {
	script := `<script>` + browserNavigationScript(base, proxyToken) + `</script>`
	lower := strings.ToLower(doc)
	if idx := strings.Index(lower, "</head>"); idx >= 0 {
		return doc[:idx] + script + doc[idx:]
	}
	return script + doc
}

func injectBrowserNavigationScriptNode(root *xhtml.Node, script string) {
	scriptNode := &xhtml.Node{Type: xhtml.ElementNode, Data: "script"}
	scriptNode.AppendChild(&xhtml.Node{Type: xhtml.TextNode, Data: script})
	if head := findBrowserHTMLNode(root, "head"); head != nil {
		head.AppendChild(scriptNode)
		return
	}
	if root != nil {
		root.AppendChild(scriptNode)
	}
}

func findBrowserHTMLNode(n *xhtml.Node, name string) *xhtml.Node {
	if n == nil {
		return nil
	}
	if n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, name) {
		return n
	}
	for child := n.FirstChild; child != nil; child = child.NextSibling {
		if found := findBrowserHTMLNode(child, name); found != nil {
			return found
		}
	}
	return nil
}

func browserNavigationScript(base *url.URL, proxyToken string) string {
	return `
(() => {
  const baseURL = ` + strconv.Quote(base.String()) + `;
  const proxyPath = ` + strconv.Quote(browserProxyPath) + `;
  const proxyToken = ` + strconv.Quote(proxyToken) + `;
  const notify = (url) => {
    try {
      window.parent.postMessage({ type: "devdeck-browser:navigate", url }, "*");
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
  const proxy = (url) => {
    const params = new URLSearchParams({ url });
    if (proxyToken) params.set("token", proxyToken);
    return proxyPath + "?" + params.toString();
  };
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
`
}
