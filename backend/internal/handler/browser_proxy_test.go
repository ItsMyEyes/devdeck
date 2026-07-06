package handler

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"loom/backend/internal/service"
)

func TestNormalizeBrowserURL(t *testing.T) {
	got, err := normalizeBrowserURL("example.com/path")
	if err != nil {
		t.Fatalf("normalizeBrowserURL: %v", err)
	}
	if got.String() != "https://example.com/path" {
		t.Fatalf("url = %q, want https://example.com/path", got.String())
	}

	if _, err := normalizeBrowserURL("file:///etc/passwd"); err == nil {
		t.Fatal("expected unsupported scheme to be rejected")
	}
}

func TestBrowserProxyRewritesHTMLAndStripsUnsafeHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Set-Cookie", "sid=remote")
		_, _ = w.Write([]byte(`<html><head></head><body><a href="/next">next</a><img src="img.png"><img srcset="/small.png 1x, /large.png 2x"></body></html>`))
	}))
	defer upstream.Close()

	h := &BrowserProxyHandler{client: upstream.Client()}
	req := httptest.NewRequest(http.MethodGet, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/page"), nil)
	rec := httptest.NewRecorder()

	h.Proxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Frame-Options") != "" {
		t.Fatalf("X-Frame-Options leaked: %q", rec.Header().Get("X-Frame-Options"))
	}
	if rec.Header().Get("Set-Cookie") != "" {
		t.Fatalf("Set-Cookie leaked: %q", rec.Header().Get("Set-Cookie"))
	}
	if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("missing sandbox CSP: %q", rec.Header().Get("Content-Security-Policy"))
	}

	body := rec.Body.String()
	if !strings.Contains(body, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/next")) {
		t.Fatalf("relative link was not rewritten: %s", body)
	}
	if !strings.Contains(body, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/img.png")) {
		t.Fatalf("relative image was not rewritten: %s", body)
	}
	if !strings.Contains(body, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/small.png")) {
		t.Fatalf("srcset was not rewritten: %s", body)
	}
}

func TestBrowserProxyPreservesTokenInRewrittenURLs(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><head></head><body><a href="/next">next</a><img src="/asset.png"></body></html>`))
	}))
	defer upstream.Close()

	h := &BrowserProxyHandler{client: upstream.Client()}
	req := httptest.NewRequest(http.MethodGet, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/page")+"&token=browser-token", nil)
	rec := httptest.NewRecorder()

	h.Proxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "token=browser-token") {
		t.Fatalf("browser token was not preserved in rewritten document: %s", body)
	}
}

func TestBrowserProxyRespectsHTMLBaseHrefForRelativeAssets(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/jaeger" {
			t.Fatalf("unexpected upstream path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><head><base href="/jaeger/"><script type="module" src="./static/app.js"></script><link rel="stylesheet" href="./static/app.css"></head></html>`))
	}))
	defer upstream.Close()

	h := &BrowserProxyHandler{client: upstream.Client()}
	req := httptest.NewRequest(http.MethodGet, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/jaeger")+"&token=browser-token", nil)
	rec := httptest.NewRecorder()

	h.Proxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	wantScript := browserProxyPath + "?token=browser-token&amp;url=" + url.QueryEscape(upstream.URL+"/jaeger/static/app.js")
	altWantScript := browserProxyPath + "?url=" + url.QueryEscape(upstream.URL+"/jaeger/static/app.js") + "&amp;token=browser-token"
	if !strings.Contains(body, wantScript) && !strings.Contains(body, altWantScript) {
		t.Fatalf("script src was not resolved through document base: %s", body)
	}
	if strings.Contains(body, url.QueryEscape(upstream.URL+"/static/app.js")) {
		t.Fatalf("script src was incorrectly resolved at host root: %s", body)
	}
	if !strings.Contains(body, `href="`+upstream.URL+`/jaeger/"`) {
		t.Fatalf("base href was not preserved as upstream base: %s", body)
	}
}

func TestBrowserProxyPersistsUpstreamCookiesPerToken(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			http.SetCookie(w, &http.Cookie{Name: "gate", Value: "open", Path: "/"})
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(`<html><head><link rel="stylesheet" href="/static/app.css"></head></html>`))
		case "/static/app.css":
			if cookie, err := r.Cookie("gate"); err == nil && cookie.Value == "open" {
				w.Header().Set("Content-Type", "text/css")
				_, _ = w.Write([]byte(`body{color:red}`))
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(`<html>fallback</html>`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	h := &BrowserProxyHandler{client: upstream.Client()}
	token := "browser-token"
	pageReq := httptest.NewRequest(http.MethodGet, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/page")+"&token="+token, nil)
	pageRec := httptest.NewRecorder()

	h.Proxy(pageRec, pageReq)

	if pageRec.Code != http.StatusOK {
		t.Fatalf("page status = %d, body = %s", pageRec.Code, pageRec.Body.String())
	}

	assetReq := httptest.NewRequest(http.MethodGet, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/static/app.css")+"&token="+token, nil)
	assetReq.Header.Set("Accept", "text/css,*/*;q=0.1")
	assetReq.Header.Set("Sec-Fetch-Dest", "style")
	assetReq.Header.Set("Sec-Fetch-Mode", "cors")
	assetReq.Header.Set("Sec-Fetch-Site", "cross-site")
	assetReq.Header.Set("Origin", "null")
	assetRec := httptest.NewRecorder()

	h.Proxy(assetRec, assetReq)

	if assetRec.Code != http.StatusOK {
		t.Fatalf("asset status = %d, body = %s", assetRec.Code, assetRec.Body.String())
	}
	if got := assetRec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/css") {
		t.Fatalf("content type = %q, want text/css", got)
	}
	if body := assetRec.Body.String(); body != `body{color:red}` {
		t.Fatalf("body = %q, want CSS", body)
	}

	otherTokenReq := httptest.NewRequest(http.MethodGet, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/static/app.css")+"&token=other-token", nil)
	otherTokenReq.Header.Set("Accept", "text/css,*/*;q=0.1")
	otherTokenReq.Header.Set("Sec-Fetch-Dest", "style")
	otherTokenRec := httptest.NewRecorder()

	h.Proxy(otherTokenRec, otherTokenReq)

	if got := otherTokenRec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/css") {
		t.Fatalf("other token content type = %q, want CSS fallback", got)
	}
	if got := otherTokenRec.Header().Get("X-Loom-Browser-Content-Mismatch"); got != "style-was-html" {
		t.Fatalf("mismatch header = %q, want style-was-html", got)
	}
}

func TestBrowserProxyNormalizesFetchMetadataForUpstream(t *testing.T) {
	var gotOrigin, gotReferer, gotFetchMode, gotFetchSite, gotFetchDest, gotUserAgent string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotOrigin = r.Header.Get("Origin")
		gotReferer = r.Header.Get("Referer")
		gotFetchMode = r.Header.Get("Sec-Fetch-Mode")
		gotFetchSite = r.Header.Get("Sec-Fetch-Site")
		gotFetchDest = r.Header.Get("Sec-Fetch-Dest")
		gotUserAgent = r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "text/css")
		_, _ = w.Write([]byte(`body{color:red}`))
	}))
	defer upstream.Close()

	h := &BrowserProxyHandler{client: upstream.Client()}
	req := httptest.NewRequest(http.MethodGet, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/static/app.css")+"&token=browser-token", nil)
	req.Header.Set("Accept", "text/css,*/*;q=0.1")
	req.Header.Set("Origin", "null")
	req.Header.Set("Sec-Fetch-Dest", "style")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := httptest.NewRecorder()

	h.Proxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if gotOrigin != "" {
		t.Fatalf("Origin = %q, want empty", gotOrigin)
	}
	if gotReferer != upstream.URL+"/" {
		t.Fatalf("Referer = %q, want %q", gotReferer, upstream.URL+"/")
	}
	if gotFetchDest != "style" {
		t.Fatalf("Sec-Fetch-Dest = %q, want style", gotFetchDest)
	}
	if gotFetchMode != "cors" {
		t.Fatalf("Sec-Fetch-Mode = %q, want cors", gotFetchMode)
	}
	if gotFetchSite != "same-origin" {
		t.Fatalf("Sec-Fetch-Site = %q, want same-origin", gotFetchSite)
	}
	if !strings.Contains(gotUserAgent, "Chrome/149.0.0.0") {
		t.Fatalf("User-Agent = %q, want browser-like Chrome UA", gotUserAgent)
	}
}

func TestBrowserProxyReturnsSingleCORSOriginHeader(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Content-Type", "font/woff2")
		_, _ = w.Write([]byte("font"))
	}))
	defer upstream.Close()

	h := &BrowserProxyHandler{client: upstream.Client()}
	req := httptest.NewRequest(http.MethodGet, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/roboto.woff2")+"&token=browser-token", nil)
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Sec-Fetch-Dest", "font")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Origin", "null")
	rec := httptest.NewRecorder()

	h.Proxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if values := rec.Header().Values("Access-Control-Allow-Origin"); len(values) != 1 || values[0] != "*" {
		t.Fatalf("Access-Control-Allow-Origin values = %#v, want exactly [*]", values)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("Access-Control-Allow-Credentials leaked: %q", got)
	}
}

func TestBrowserProxyDoesNotRewriteInlineScriptsAsHTMLAttributes(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><head><script>const src = "/static/app.js"; const href = "/home";</script></head><body><a href="/next">next</a></body></html>`))
	}))
	defer upstream.Close()

	h := &BrowserProxyHandler{client: upstream.Client()}
	req := httptest.NewRequest(http.MethodGet, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/page")+"&token=browser-token", nil)
	rec := httptest.NewRecorder()

	h.Proxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `const src = "/static/app.js"; const href = "/home";`) {
		t.Fatalf("inline script was unexpectedly rewritten: %s", body)
	}
	if !strings.Contains(body, browserProxyPath+"?token=browser-token&amp;url="+url.QueryEscape(upstream.URL+"/next")) &&
		!strings.Contains(body, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/next")+"&amp;token=browser-token") {
		t.Fatalf("anchor href was not rewritten: %s", body)
	}
}

func TestBrowserProxyReturnsScriptStubWhenUpstreamServesHTMLForModule(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html>login</html>`))
	}))
	defer upstream.Close()

	h := &BrowserProxyHandler{client: upstream.Client()}
	req := httptest.NewRequest(http.MethodGet, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/static/app.js")+"&token=browser-token", nil)
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Sec-Fetch-Dest", "script")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	rec := httptest.NewRecorder()

	h.Proxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/javascript") {
		t.Fatalf("Content-Type = %q, want application/javascript", got)
	}
	if got := rec.Header().Get("X-Loom-Browser-Content-Mismatch"); got != "script-was-html" {
		t.Fatalf("mismatch header = %q, want script-was-html", got)
	}
	if body := rec.Body.String(); !strings.Contains(body, "upstream returned HTML for script") {
		t.Fatalf("body = %q, want explanatory console error", body)
	}
}

func TestBrowserProxyRejectsInvalidTokenWhenAuthConfigured(t *testing.T) {
	called := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	h := &BrowserProxyHandler{client: upstream.Client(), svc: newTestAuthServiceForMiddleware(t)}
	req := httptest.NewRequest(http.MethodGet, browserProxyPath+"?url="+url.QueryEscape(upstream.URL)+"&token=invalid", nil)
	rec := httptest.NewRecorder()

	h.Proxy(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if called {
		t.Fatal("upstream was called despite invalid browser proxy token")
	}
}

func TestBrowserProxyAcceptsValidTokenWhenAuthConfigured(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	}))
	defer upstream.Close()

	svc := newTestAuthServiceForMiddleware(t)
	sessionToken := issuePasswordOnlySession(t, svc)
	proxyToken, err := svc.IssueBrowserProxyToken(sessionToken)
	if err != nil {
		t.Fatal(err)
	}

	h := &BrowserProxyHandler{client: upstream.Client(), svc: svc}
	req := httptest.NewRequest(http.MethodGet, browserProxyPath+"?url="+url.QueryEscape(upstream.URL)+"&token="+url.QueryEscape(proxyToken), nil)
	rec := httptest.NewRecorder()

	h.Proxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "ok" {
		t.Fatalf("body = %q, want ok", rec.Body.String())
	}
}

func issuePasswordOnlySession(t *testing.T, svc *service.AuthService) string {
	t.Helper()
	svc.SetTOTPRequired(false)
	_, pendingToken, err := svc.Register("browser@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	sessionToken, _, err := svc.CompleteLogin(pendingToken)
	if err != nil {
		t.Fatal(err)
	}
	return sessionToken
}
