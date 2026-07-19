package handler

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestRedactJSON(t *testing.T) {
	tests := []struct {
		name, in, want string
	}{
		{
			"password value hidden",
			`{"email":"a@b.c","password":"hunter2"}`,
			`{"email":"a@b.c","password":"[redacted]"}`,
		},
		{
			"totp code and camelCase keys",
			`{"code":"123456","otpauthUri":"otpauth://totp/x?secret=ABC"}`,
			`{"code":"[redacted]","otpauthUri":"[redacted]"}`,
		},
		{
			"backup codes array",
			`{"backupCodes":["aaa","bbb"]}`,
			`{"backupCodes":"[redacted]"}`,
		},
		{
			"truncated string value still redacted",
			`{"password":"hunt`,
			`{"password":"[redacted]"`,
		},
		{
			"non-sensitive keys untouched",
			`{"name":"acme","status":"paid"}`,
			`{"name":"acme","status":"paid"}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := redactJSON(tt.in); got != tt.want {
				t.Errorf("redactJSON(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestBodyForLog(t *testing.T) {
	if got := bodyForLog("multipart/form-data; boundary=x", []byte("binarybytes"), 5000); !strings.Contains(got, "multipart/form-data") || !strings.Contains(got, "5000B") || strings.Contains(got, "binarybytes") {
		t.Errorf("multipart body must be summarized, not dumped: %q", got)
	}
	if got := bodyForLog("application/json", []byte(`{"a":1}`), 7); got != `{"a":1}` {
		t.Errorf("json body should be logged verbatim: %q", got)
	}
	if got := bodyForLog("application/json", []byte(`{"a":1`), 100); !strings.Contains(got, "+94B") {
		t.Errorf("truncated body should note remaining bytes: %q", got)
	}
	// Log-forging newlines in a body must not survive into the log.
	if got := bodyForLog("application/json", []byte("{\"a\":\"x\nFAKE LOG LINE\"}"), 23); strings.Contains(got, "\n") {
		t.Errorf("control characters must be flattened: %q", got)
	}
}

// captureLog runs fn while the stdlib logger writes to a buffer.
func captureLog(fn func()) string {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)
	fn()
	return buf.String()
}

func TestAccessLogAuditsAPIRequests(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = decodeBody(r, nil) // consume the body like a real handler
		writeErr(w, http.StatusUnauthorized, "unauthorized")
	})
	mw := AccessLog(nil, "")(next)

	out := captureLog(func() {
		r := httptest.NewRequest(http.MethodPost, "/api/auth/login?next=%2Fdash",
			strings.NewReader(`{"email":"a@b.c","password":"hunter2"}`))
		r.RemoteAddr = "203.0.113.7:4321"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("User-Agent", "sqlmap/1.7")
		r.Header.Set("Cookie", "devdeck_session=supersecret")
		mw.ServeHTTP(httptest.NewRecorder(), r)
	})

	for _, want := range []string{
		"203.0.113.7 POST /api/auth/login?next=%2Fdash -> 401",
		"hdr User-Agent: sqlmap/1.7",
		"hdr Cookie: [redacted]",
		`req {"email":"a@b.c","password":"[redacted]"}`,
		`res {"error":"unauthorized"}`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("audit log missing %q in:\n%s", want, out)
		}
	}
	for _, banned := range []string{"hunter2", "supersecret"} {
		if strings.Contains(out, banned) {
			t.Errorf("secret %q leaked into the log:\n%s", banned, out)
		}
	}
}

func TestAccessLogSkipsAuditForStaticAssets(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<html>"))
	})
	mw := AccessLog(nil, "")(next)
	out := captureLog(func() {
		r := httptest.NewRequest(http.MethodGet, "/assets/index.js", nil)
		r.Header.Set("User-Agent", "Mozilla/5.0")
		mw.ServeHTTP(httptest.NewRecorder(), r)
	})
	if strings.Contains(out, "hdr ") || strings.Contains(out, "res ") {
		t.Errorf("static asset requests should stay one line:\n%s", out)
	}
	if !strings.Contains(out, "GET /assets/index.js -> 200") {
		t.Errorf("summary line missing:\n%s", out)
	}
}

func TestAccessLogAuditsUnreadBody(t *testing.T) {
	// A handler that rejects before reading the body (e.g. auth middleware)
	// leaves nothing in the tap; the log must not block or invent a body.
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
	})
	mw := AccessLog(nil, "")(next)
	out := captureLog(func() {
		r := httptest.NewRequest(http.MethodPost, "/api/workspaces", strings.NewReader(`{"name":"x"}`))
		r.Header.Set("Content-Type", "application/json")
		mw.ServeHTTP(httptest.NewRecorder(), r)
	})
	if strings.Contains(out, "req {") {
		t.Errorf("unread body should not appear in the log:\n%s", out)
	}
	if !strings.Contains(out, `res {"error":"unauthorized"}`) {
		t.Errorf("response body missing:\n%s", out)
	}
}
