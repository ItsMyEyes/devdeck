// Package service: FaviconService resolves a bookmarked page's favicon as a
// data URL for the machine-proxied Browser tile. See
// docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md for
// why a forward proxy exists per machine at all.
package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	xhtml "golang.org/x/net/html"

	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/port"
)

const (
	// faviconFetchTimeout bounds StartProxy + the HTML fetch + the icon fetch
	// together. A slow or unreachable machine degrades to "no icon", never to
	// a slow bookmark save.
	faviconFetchTimeout = 6 * time.Second
	// faviconMaxIconBytes caps what's accepted as an icon — plenty for a
	// favicon, small enough that a bookmarks table full of them stays cheap.
	faviconMaxIconBytes = 64 << 10
	// faviconMaxHTMLBytes caps how much of the page is scanned for a <link
	// rel="icon">; oversized pages just skip straight to the /favicon.ico
	// fallback rather than aborting the whole lookup.
	faviconMaxHTMLBytes = 2 << 20
)

// FaviconService fetches a page's favicon through the MACHINE'S OWN forward
// proxy — never directly from the hub's network — because a bookmarked page
// is very often only reachable from that machine (localhost dev servers,
// tailnet-internal hosts the hub itself can't resolve).
type FaviconService struct {
	st port.Store
}

func NewFaviconService(st port.Store) *FaviconService {
	return &FaviconService{st: st}
}

// Fetch best-effort resolves pageURL's favicon as a data URL. Any failure —
// unknown machine, unreachable proxy, no icon found, icon too large — yields
// "" rather than an error: a missing icon is never a reason to fail a
// bookmark save.
func (s *FaviconService) Fetch(ctx context.Context, machineID, pageURL string) string {
	if machineID == "" {
		return ""
	}
	machine, err := s.st.MachineByID(machineID)
	if err != nil {
		return ""
	}

	ctx, cancel := context.WithTimeout(ctx, faviconFetchTimeout)
	defer cancel()

	proxyResult, err := machineclient.StartProxy(ctx, machine)
	if err != nil {
		return ""
	}
	client := proxyHTTPClient(proxyResult.HTTPProxyAddr)

	page, err := url.Parse(pageURL)
	if err != nil || (page.Scheme != "http" && page.Scheme != "https") {
		return ""
	}

	for _, candidate := range faviconCandidates(ctx, client, page) {
		if dataURL := fetchIconDataURL(ctx, client, candidate); dataURL != "" {
			return dataURL
		}
	}
	return ""
}

// proxyHTTPClient dials everything through the machine's forward proxy — see
// netproxy.NewHTTPProxyHandler's doc comment for why no auth key is needed
// (the proxy is ephemeral-port + tailnet-scoped, not exposed publicly).
func proxyHTTPClient(httpProxyAddr string) *http.Client {
	proxyURL := &url.URL{Scheme: "http", Host: httpProxyAddr}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = http.ProxyURL(proxyURL)
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
}

// faviconCandidates returns icon URLs to try in order: the page's own <link
// rel="icon"> (if the page is reachable and is actually HTML), then the
// well-known /favicon.ico fallback every site is expected to serve.
func faviconCandidates(ctx context.Context, client *http.Client, page *url.URL) []*url.URL {
	root := &url.URL{Scheme: page.Scheme, Host: page.Host, Path: "/favicon.ico"}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, page.String(), nil)
	if err != nil {
		return []*url.URL{root}
	}
	resp, err := client.Do(req)
	if err != nil {
		return []*url.URL{root}
	}
	defer resp.Body.Close()

	mediaType, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if !strings.EqualFold(mediaType, "text/html") {
		return []*url.URL{root}
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, faviconMaxHTMLBytes))
	if err != nil {
		return []*url.URL{root}
	}

	// Resolve against the final (post-redirect) URL, not the original
	// bookmark URL, so a relative href survives a page that redirects.
	base := page
	if resp.Request != nil && resp.Request.URL != nil {
		base = resp.Request.URL
	}

	if href := extractFaviconHref(body); href != "" {
		if parsed, err := url.Parse(href); err == nil {
			resolved := base.ResolveReference(parsed)
			if resolved.Scheme == "http" || resolved.Scheme == "https" {
				return []*url.URL{resolved, root}
			}
		}
	}
	return []*url.URL{root}
}

// extractFaviconHref walks parsed HTML for the first icon <link>'s href,
// preferring earlier <head> entries since sites list their primary favicon
// first when they declare more than one size/format.
func extractFaviconHref(htmlBytes []byte) string {
	root, err := xhtml.Parse(bytes.NewReader(htmlBytes))
	if err != nil {
		return ""
	}
	var href string
	var walk func(n *xhtml.Node) bool
	walk = func(n *xhtml.Node) bool {
		if n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "link") {
			var rel, h string
			for _, attr := range n.Attr {
				switch strings.ToLower(attr.Key) {
				case "rel":
					rel = strings.ToLower(attr.Val)
				case "href":
					h = strings.TrimSpace(attr.Val)
				}
			}
			if h != "" && isIconRel(rel) {
				href = h
				return true
			}
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			if walk(child) {
				return true
			}
		}
		return false
	}
	walk(root)
	return href
}

func isIconRel(rel string) bool {
	for _, token := range strings.Fields(rel) {
		switch token {
		case "icon", "apple-touch-icon", "apple-touch-icon-precomposed", "mask-icon":
			return true
		}
	}
	return false
}

// fetchIconDataURL fetches iconURL through client and encodes it as a data
// URL, or "" if it's missing, not actually an image, or too large.
func fetchIconDataURL(ctx context.Context, client *http.Client, iconURL *url.URL) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, iconURL.String(), nil)
	if err != nil {
		return ""
	}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}

	// Many dev-server /favicon.ico responses either omit Content-Type or mislabel
	// it (application/octet-stream, text/plain) — trust a real image/* type when
	// given one, otherwise fall back to sniffing the icon's own file extension
	// rather than rejecting it outright.
	mediaType, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if !strings.HasPrefix(mediaType, "image/") {
		sniffed, ok := sniffIconMediaType(iconURL.Path)
		if !ok {
			return ""
		}
		mediaType = sniffed
	}

	data, err := io.ReadAll(io.LimitReader(resp.Body, faviconMaxIconBytes+1))
	if err != nil || len(data) == 0 || len(data) > faviconMaxIconBytes {
		return ""
	}
	return fmt.Sprintf("data:%s;base64,%s", mediaType, base64.StdEncoding.EncodeToString(data))
}

// sniffIconMediaType maps a recognized icon file extension to its media type.
// Unrecognized extensions return ok=false rather than guessing — a candidate
// URL with a real image/* Content-Type never reaches here (see
// fetchIconDataURL), so this only covers servers that mislabel or omit it.
func sniffIconMediaType(path string) (string, bool) {
	lower := strings.ToLower(path)
	switch {
	case strings.HasSuffix(lower, ".ico"):
		return "image/x-icon", true
	case strings.HasSuffix(lower, ".png"):
		return "image/png", true
	case strings.HasSuffix(lower, ".svg"):
		return "image/svg+xml", true
	case strings.HasSuffix(lower, ".jpg"), strings.HasSuffix(lower, ".jpeg"):
		return "image/jpeg", true
	case strings.HasSuffix(lower, ".webp"):
		return "image/webp", true
	case strings.HasSuffix(lower, ".gif"):
		return "image/gif", true
	default:
		return "", false
	}
}
