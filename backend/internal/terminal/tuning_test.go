package terminal

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

func TestReplayHelperProcess(t *testing.T) {
	if os.Getenv("LOOM_TEST_REPLAY_HELPER") != "1" {
		return
	}
	_, _ = os.Stdout.Write([]byte("replay-marker-7f3a"))
	time.Sleep(2 * time.Second)
	os.Exit(0)
}

// TestAttachDeliversBannerAndBufferedReplay verifies that attachConn itself
// queues the banner plus ring-buffered history for delivery — all conn writes
// go through the pump's single coalescing writer, so replayed history can
// never interleave out of order with live PTY output.
func TestAttachDeliversBannerAndBufferedReplay(t *testing.T) {
	activeRegistry = newRegistry()
	session := testSessionID(t)

	cmd := exec.Command(os.Args[0], "-test.run=TestReplayHelperProcess")
	cmd.Env = append(os.Environ(), "LOOM_TEST_REPLAY_HELPER=1")
	sess, err := activeRegistry.spawn(session, cmd, 80, 24)
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	defer activeRegistry.kill(session)

	// Let the marker land in the ring buffer before anyone is attached.
	time.Sleep(500 * time.Millisecond)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		sess.attachConn(conn, 80, 24, []byte("BANNER|"))
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

	want := "BANNER|replay-marker-7f3a"
	var got []byte
	for !strings.Contains(string(got), want) {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (received so far: %q)", err, got)
		}
		got = append(got, data...)
	}
}

// TestHandleWSNegotiatesCompression verifies the server offers
// permessage-deflate: terminal output is highly repetitive ANSI text, and
// without compression it crosses slow links (e.g. production behind a
// tunnel) uncompressed.
func TestHandleWSNegotiatesCompression(t *testing.T) {
	srv := NewServer(nil)
	session := testSessionID(t)
	ts := httptest.NewServer(http.HandlerFunc(srv.HandleWS))
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"?session="+session,
		&websocket.DialOptions{CompressionMode: websocket.CompressionContextTakeover})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer srv.registry.kill(session)
	defer conn.CloseNow()

	ext := resp.Header.Get("Sec-WebSocket-Extensions")
	if !strings.Contains(ext, "permessage-deflate") {
		t.Fatalf("compression not negotiated; Sec-WebSocket-Extensions=%q", ext)
	}
}
