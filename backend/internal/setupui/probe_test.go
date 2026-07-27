package setupui

import (
	"context"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"devdeck/backend/internal/detect"
)

// ---------------------------------------------------------------------------
// Tailscale detection (wizard step 6)
// ---------------------------------------------------------------------------

func TestProbeTailscaleWith(t *testing.T) {
	tests := []struct {
		name        string
		probe       TailscaleProbe
		wantURL     string
		wantReason  string
		wantFound   bool
		wantMessage string // substring
	}{
		{
			name:        "on the tailnet",
			probe:       func() (string, string) { return "https://builder.tail-abc.ts.net", "" },
			wantURL:     "https://builder.tail-abc.ts.net",
			wantReason:  "",
			wantFound:   true,
			wantMessage: "builder.tail-abc.ts.net",
		},
		{
			name:        "cli not installed",
			probe:       func() (string, string) { return "", ReasonNotInstalled },
			wantURL:     "",
			wantReason:  ReasonNotInstalled,
			wantFound:   false,
			wantMessage: "not installed",
		},
		{
			name:        "installed but not on a tailnet",
			probe:       func() (string, string) { return "", ReasonNotReady },
			wantURL:     "",
			wantReason:  ReasonNotReady,
			wantFound:   false,
			wantMessage: "not on a tailnet",
		},
		{
			name:        "unexpected reason is surfaced verbatim",
			probe:       func() (string, string) { return "", "some_new_reason" },
			wantURL:     "",
			wantReason:  "some_new_reason",
			wantFound:   false,
			wantMessage: "some_new_reason",
		},
		{
			name:        "nil probe never panics and never claims a tailnet",
			probe:       nil,
			wantURL:     "",
			wantReason:  ReasonNotInstalled,
			wantFound:   false,
			wantMessage: "not installed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ProbeTailscaleWith(tt.probe)
			if got.URL != tt.wantURL {
				t.Errorf("URL = %q, want %q", got.URL, tt.wantURL)
			}
			if got.Reason != tt.wantReason {
				t.Errorf("Reason = %q, want %q", got.Reason, tt.wantReason)
			}
			if got.Found() != tt.wantFound {
				t.Errorf("Found() = %v, want %v", got.Found(), tt.wantFound)
			}
			if !strings.Contains(got.Message(), tt.wantMessage) {
				t.Errorf("Message() = %q, want it to contain %q", got.Message(), tt.wantMessage)
			}
			// The invariant detect.TailscaleSelfURL promises: never both empty,
			// never a URL alongside a reason. The wizard branches on it.
			if (got.URL == "") == (got.Reason == "") {
				t.Errorf("URL = %q, Reason = %q — exactly one must be set", got.URL, got.Reason)
			}
		})
	}
}

// The reason strings are detect's, not ours; this fails the moment the two
// packages disagree about how "the CLI isn't installed" is spelled.
func TestProbeTailscaleReasonsMatchDetect(t *testing.T) {
	notInstalled := ProbeTailscaleWith(func() (string, string) {
		return detect.TailscaleSelfURLWith(func() (string, error) {
			return "", errors.New("tailscale not found")
		})
	})
	if notInstalled.Found() {
		t.Fatalf("Found() = true with no tailscale CLI, want false (result %+v)", notInstalled)
	}
	if notInstalled.Reason != ReasonNotInstalled {
		t.Errorf("Reason = %q, want %q — detect and setupui must agree", notInstalled.Reason, ReasonNotInstalled)
	}
	if !strings.Contains(notInstalled.Message(), "not installed") {
		t.Errorf("Message() = %q, want it to explain the CLI is missing", notInstalled.Message())
	}
}

func TestTailscaleResultPublicURL(t *testing.T) {
	tests := []struct {
		name   string
		result TailscaleResult
		addr   string
		want   string
	}{
		{
			name:   "tailnet URL wins over the listen address",
			result: TailscaleResult{URL: "https://builder.tail-abc.ts.net"},
			addr:   "0.0.0.0:9199",
			want:   "https://builder.tail-abc.ts.net",
		},
		{
			name:   "falls back to http://<addr>",
			result: TailscaleResult{Reason: ReasonNotInstalled},
			addr:   "0.0.0.0:9199",
			want:   "http://0.0.0.0:9199",
		},
		{
			name:   "no tailnet and no addr yields no suggestion",
			result: TailscaleResult{Reason: ReasonNotReady},
			addr:   "  ",
			want:   "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.result.PublicURL(tt.addr); got != tt.want {
				t.Errorf("PublicURL(%q) = %q, want %q", tt.addr, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Hub reachability (wizard step 8)
// ---------------------------------------------------------------------------

// hubStub serves /api/whoami the way a real hub does: 200 for the right
// bearer key, 401 for anything else.
func hubStub(t *testing.T, key string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/whoami" {
			t.Errorf("hub was asked for %q, want /api/whoami", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+key {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestCheckHubReachable(t *testing.T) {
	srv := hubStub(t, "right-key")

	got := CheckHub(context.Background(), srv.URL, "right-key")
	if !got.OK() {
		t.Fatalf("OK() = false, want true (result %+v)", got)
	}
	if got.Status != HubOK {
		t.Errorf("Status = %v, want %v", got.Status, HubOK)
	}
	if got.Detail == "" {
		t.Error("Detail = \"\", want a line the wizard can show next to the ✓")
	}
}

func TestCheckHubTrimsTrailingSlash(t *testing.T) {
	srv := hubStub(t, "k") // the stub fails the test if the path is wrong

	if got := CheckHub(context.Background(), srv.URL+"/", "k"); !got.OK() {
		t.Fatalf("OK() = false for a hub URL with a trailing slash: %+v", got)
	}
}

func TestCheckHubRejectsWrongKey(t *testing.T) {
	tests := []struct {
		name   string
		status int
	}{
		{"401 unauthorized", http.StatusUnauthorized},
		{"403 forbidden", http.StatusForbidden},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
			}))
			t.Cleanup(srv.Close)

			got := CheckHub(context.Background(), srv.URL, "wrong-key")
			if got.Status != HubBadKey {
				t.Fatalf("Status = %v, want %v — a wrong hub key must fail loudly here, not 30s after boot", got.Status, HubBadKey)
			}
			if got.OK() {
				t.Error("OK() = true for a rejected key")
			}
			if !strings.Contains(got.Detail, "key") {
				t.Errorf("Detail = %q, want it to say the key was rejected", got.Detail)
			}
		})
	}
}

func TestCheckHubUnreachable(t *testing.T) {
	got := CheckHub(context.Background(), "http://127.0.0.1:1", "k")
	if got.Status != HubUnreachable {
		t.Fatalf("Status = %v, want %v (result %+v)", got.Status, HubUnreachable, got)
	}
	if !strings.Contains(got.Detail, "127.0.0.1:1") {
		t.Errorf("Detail = %q, want the actual connection error, address included", got.Detail)
	}
}

func TestCheckHubSurfacesTheActualTransportError(t *testing.T) {
	client := &http.Client{Transport: stubRoundTripper{err: errors.New("boom-sentinel")}}

	got := CheckHubWith(context.Background(), client, "http://hub.example", "k")
	if got.Status != HubUnreachable {
		t.Fatalf("Status = %v, want %v", got.Status, HubUnreachable)
	}
	if !strings.Contains(got.Detail, "boom-sentinel") {
		t.Errorf("Detail = %q, want it to carry the underlying error text", got.Detail)
	}
}

func TestCheckHubUnexpectedStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	got := CheckHub(context.Background(), srv.URL, "k")
	if got.OK() {
		t.Fatal("OK() = true for a hub that answered 500")
	}
	if !strings.Contains(got.Detail, "500") {
		t.Errorf("Detail = %q, want the actual status code", got.Detail)
	}
}

func TestCheckHubRejectsEmptyURL(t *testing.T) {
	tests := []struct {
		name   string
		hubURL string
	}{
		{"empty", ""},
		{"whitespace", "   "},
		{"no scheme", "hq.tail-abc.ts.net"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CheckHub(context.Background(), tt.hubURL, "k")
			if got.OK() {
				t.Fatalf("OK() = true for hub URL %q", tt.hubURL)
			}
			if got.Detail == "" {
				t.Error("Detail = \"\", want an explanation")
			}
		})
	}
}

// A wrong hub URL must never hang the wizard: the built-in timeout is short,
// and an explicit deadline is honoured.
func TestCheckHubIsBounded(t *testing.T) {
	if hubProbeTimeout > 10*time.Second {
		t.Errorf("hubProbeTimeout = %v, want a few seconds — the wizard must never block on it", hubProbeTimeout)
	}

	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		<-release
	}))
	t.Cleanup(func() {
		close(release)
		srv.Close()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	got := CheckHub(ctx, srv.URL, "k")
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("CheckHub blocked for %v on an unresponsive hub", elapsed)
	}
	if got.Status != HubUnreachable {
		t.Errorf("Status = %v, want %v", got.Status, HubUnreachable)
	}
}

// stubRoundTripper answers every request with a canned response (or error) and
// records whether the response body was closed.
type stubRoundTripper struct {
	status int
	body   *trackedBody
	err    error
}

func (rt stubRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	if rt.err != nil {
		return nil, rt.err
	}
	return &http.Response{
		StatusCode: rt.status,
		Status:     http.StatusText(rt.status),
		Body:       rt.body,
		Header:     make(http.Header),
	}, nil
}

type trackedBody struct {
	mu     sync.Mutex
	reader io.Reader
	closed bool
}

func (b *trackedBody) Read(p []byte) (int, error) { return b.reader.Read(p) }

func (b *trackedBody) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	return nil
}

func (b *trackedBody) wasClosed() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.closed
}

func TestCheckHubAlwaysClosesTheBody(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusUnauthorized, http.StatusInternalServerError} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			body := &trackedBody{reader: strings.NewReader(`{"role":"hub"}`)}
			client := &http.Client{Transport: stubRoundTripper{status: status, body: body}}

			CheckHubWith(context.Background(), client, "http://hub.example", "k")
			if !body.wasClosed() {
				t.Error("response body was not closed — the wizard leaks a connection per probe")
			}
		})
	}
}

func TestHubStatusString(t *testing.T) {
	tests := []struct {
		status HubStatus
		want   string
	}{
		{HubUnknown, "unknown"},
		{HubOK, "ok"},
		{HubBadKey, "bad_key"},
		{HubUnreachable, "unreachable"},
	}

	for _, tt := range tests {
		if got := tt.status.String(); got != tt.want {
			t.Errorf("HubStatus(%d).String() = %q, want %q", int(tt.status), got, tt.want)
		}
	}
}

// The zero value is "not checked yet", never "OK" — a wizard that has not run
// the probe must not render a ✓.
func TestZeroHubResultIsNotOK(t *testing.T) {
	var zero HubResult
	if zero.OK() {
		t.Error("zero HubResult reports OK() = true; it must mean 'not checked yet'")
	}
	if zero.Status != HubUnknown {
		t.Errorf("zero Status = %v, want %v", zero.Status, HubUnknown)
	}
}

// ---------------------------------------------------------------------------
// Key generation (wizard step 5)
// ---------------------------------------------------------------------------

func TestGenerateKeyIs32RandomBytesHex(t *testing.T) {
	key := GenerateKey()

	if len(key) != 64 {
		t.Fatalf("len(GenerateKey()) = %d, want 64 hex chars (32 bytes)", len(key))
	}
	raw, err := hex.DecodeString(key)
	if err != nil {
		t.Fatalf("GenerateKey() = %q, not hex: %v", key, err)
	}
	if len(raw) != 32 {
		t.Errorf("decoded key = %d bytes, want 32", len(raw))
	}
	if strings.ToLower(key) != key {
		t.Errorf("GenerateKey() = %q, want lowercase hex", key)
	}
}

func TestGenerateKeyIsUnique(t *testing.T) {
	seen := make(map[string]bool, 64)
	for i := 0; i < 64; i++ {
		key := GenerateKey()
		if seen[key] {
			t.Fatalf("GenerateKey() repeated %q after %d calls — not random", key, i)
		}
		seen[key] = true
	}
}
