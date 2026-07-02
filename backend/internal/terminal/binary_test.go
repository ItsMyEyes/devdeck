package terminal

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// TestPumpForwardsSplitUTF8IntactAsBinary reproduces the "connection error"
// symptom seen after a reattach: PTY output containing a multi-byte UTF-8
// character (e.g. "■" U+25A0, common in TUI box-drawing/spinners) can arrive
// split across two separate ptmx reads. A WebSocket Text frame's payload
// must be complete, valid UTF-8 per RFC 6455 — browsers fail the connection
// the instant a split character is sent as Text, even though the Go server
// itself reports no error. Sending raw PTY bytes as Binary frames instead
// sidesteps this: arbitrary byte sequences are never subject to UTF-8
// validation, and the frontend already treats binary frames as raw output.
func TestPumpForwardsSplitUTF8IntactAsBinary(t *testing.T) {
	activeRegistry = newRegistry()
	session := testSessionID(t)

	// Emits "■" (0xE2 0x96 0xA0) as two separate writes, with a gap so the
	// registry's pump() goroutine reads them as two distinct chunks instead
	// of coalescing them into one — mirroring how a 4096-byte ptmx.Read or a
	// ring-buffer chunk eviction can split a multi-byte character in two.
	cmd := exec.Command("/bin/sh", "-c", `sleep 0.3; printf '\342\226'; sleep 0.3; printf '\240'`)
	sess, err := activeRegistry.spawn(session, cmd, 80, 24)
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		sess.attachConn(conn, 80, 24)
		time.Sleep(1200 * time.Millisecond)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	want := []byte{0xE2, 0x96, 0xA0}
	var got []byte
	for len(got) < len(want) {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if typ != websocket.MessageBinary {
			t.Fatalf("expected MessageBinary, got %v", typ)
		}
		got = append(got, data...)
	}

	if !bytes.Equal(got, want) {
		t.Fatalf("got %x, want %x", got, want)
	}
}
