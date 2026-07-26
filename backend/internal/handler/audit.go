package handler

import (
	"fmt"
	"io"
	"mime"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

// The access log is the audit trail for spotting abuse, so /api and /ws
// requests are logged in full: every request header, the request body, and
// the response body — capped and with secrets redacted before they reach
// the log.
const (
	logBodyCap  = 2048 // bytes of request/response body preserved for the log
	logValueCap = 512  // max length of a single logged header value
)

// redactedHeaders carry credentials; their presence is logged, never their
// value. Keys must be in canonical MIME header form.
var redactedHeaders = map[string]bool{
	"Authorization":       true,
	"Proxy-Authorization": true,
	"Cookie":              true,
	"X-Auth-Token":        true,
	"X-Api-Key":           true,
}

// sensitiveJSONField matches JSON keys that carry secrets (password, TOTP
// code/otpauth URI, tokens, backup codes, API/machine keys) together with
// their value — string, array, or number, possibly cut off by the capture
// cap. Operating on raw text keeps redaction working even when the captured
// body is truncated mid-value. Over-matching (e.g. "postalCode", "keyword")
// is the safe direction.
//
// "key" earns its place: it is the field name used by GET /api/self/hub-key
// for this hub's own bearer key, and by POST/PATCH /api/machines for a
// runtime's key. Both are live credentials, and without this they were
// written to the access log in cleartext.
var sensitiveJSONField = regexp.MustCompile(`(?i)("[a-z0-9_]*(?:password|secret|token|otp|code|key)[a-z0-9_-]*"\s*:\s*)("(?:[^"\\]|\\.)*"?|\[[^\]]*\]?|-?[0-9.]+)`)

func redactJSON(s string) string {
	return sensitiveJSONField.ReplaceAllString(s, `$1"[redacted]"`)
}

// bodyTap tees the first logBodyCap bytes of a request body as the handler
// reads it, without buffering large uploads or touching bodies the handler
// never consumes.
type bodyTap struct {
	rc    io.ReadCloser
	buf   []byte
	total int64
}

func (t *bodyTap) Read(p []byte) (int, error) {
	n, err := t.rc.Read(p)
	if n > 0 {
		t.total += int64(n)
		if room := logBodyCap - len(t.buf); room > 0 {
			if n < room {
				room = n
			}
			t.buf = append(t.buf, p[:room]...)
		}
	}
	return n, err
}

func (t *bodyTap) Close() error { return t.rc.Close() }

// formatAudit renders the header/body detail lines appended to the access
// log line for /api and /ws requests.
func formatAudit(r *http.Request, reqBody *bodyTap, rec *statusRecorder) string {
	var b strings.Builder
	names := make([]string, 0, len(r.Header))
	for name := range r.Header {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		v := strings.Join(r.Header.Values(name), ", ")
		if redactedHeaders[name] {
			v = "[redacted]"
		}
		fmt.Fprintf(&b, "\n      hdr %s: %s", name, clip(sanitizeLogText(v), logValueCap))
	}
	if reqBody != nil && reqBody.total > 0 {
		b.WriteString("\n      req " + bodyForLog(r.Header.Get("Content-Type"), reqBody.buf, reqBody.total))
	}
	switch {
	case rec.hijacked:
		b.WriteString("\n      res [connection hijacked: websocket]")
	case rec.bodyTotal > 0:
		b.WriteString("\n      res " + bodyForLog(rec.Header().Get("Content-Type"), rec.bodyBuf, rec.bodyTotal))
	}
	return b.String()
}

// bodyForLog renders a captured body: JSON-ish bodies are sanitized and
// redacted; binary/multipart bodies (file uploads, attachment downloads)
// are summarized instead of dumped.
func bodyForLog(contentType string, captured []byte, total int64) string {
	mediaType, _, _ := mime.ParseMediaType(contentType)
	isJSON := strings.Contains(mediaType, "json") ||
		(mediaType == "" && len(captured) > 0 && (captured[0] == '{' || captured[0] == '['))
	if !isJSON {
		if mediaType == "" {
			mediaType = "unknown content type"
		}
		return fmt.Sprintf("[%s, %dB — not logged]", mediaType, total)
	}
	s := strings.TrimSpace(redactJSON(sanitizeLogText(string(captured))))
	if extra := total - int64(len(captured)); extra > 0 {
		s += fmt.Sprintf(" … (+%dB)", extra)
	}
	return s
}

// sanitizeLogText flattens control characters so a hostile body can't forge
// extra log lines or corrupt the terminal.
func sanitizeLogText(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
}

func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for max > 0 && s[max]&0xC0 == 0x80 { // don't cut mid-rune
		max--
	}
	return s[:max] + "…"
}
