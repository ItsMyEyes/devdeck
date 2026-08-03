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

// Helper child: emit more output than the ring buffer holds, then idle so the
// session survives the attach under test.
func TestChunkReplayHelperProcess(t *testing.T) {
	if os.Getenv("DEVDECK_TEST_CHUNK_HELPER") != "1" {
		return
	}
	line := strings.Repeat("x", 255) + "\n"
	for written := 0; written < 3*ringBufferMaxBytes; written += len(line) {
		_, _ = os.Stdout.Write([]byte(line))
	}
	time.Sleep(30 * time.Second)
	os.Exit(0)
}

// A reattaching client is replayed the whole ring buffer. Sending it as one
// WebSocket message puts the entire payload under a single connWriteTimeout,
// so any link too slow to carry ringBufferMaxBytes within that window can
// never complete a reconnect: the write times out, the pump closes the
// connection, the client reconnects, and is handed the identical payload
// again — zero forward progress, forever.
//
// Bounding every write to replayChunkBytes gives each chunk its own deadline,
// so the throughput a session needs to stay attached is set by the chunk size
// rather than by however much history happens to be buffered.
func TestReplayIsSentInBoundedChunks(t *testing.T) {
	activeRegistry = newRegistry()
	session := testSessionID(t)

	cmd := exec.Command(os.Args[0], "-test.run=TestChunkReplayHelperProcess")
	cmd.Env = append(os.Environ(), "DEVDECK_TEST_CHUNK_HELPER=1")
	sess, err := activeRegistry.spawn(session, cmd, 80, 24)
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	defer activeRegistry.kill(session)

	// Let the child fill the ring buffer and go quiet, so what the attaching
	// client receives is replay rather than live output.
	time.Sleep(2 * time.Second)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		sess.attachConn(conn, 80, 24, []byte("BANNER|"))
		time.Sleep(2 * time.Second)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"),
		&websocket.DialOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(8 << 20)

	var total, largest int
	var received []byte
	readCtx, readCancel := context.WithTimeout(ctx, 6*time.Second)
	defer readCancel()
	for {
		_, data, err := conn.Read(readCtx)
		if err != nil {
			break
		}
		total += len(data)
		if len(data) > largest {
			largest = len(data)
		}
		if len(received) < 4096 {
			received = append(received, data...)
		}
	}

	if total == 0 {
		t.Fatal("client received no replay at all")
	}
	if largest > replayChunkBytes {
		t.Errorf("largest WebSocket message = %d bytes, want <= replayChunkBytes (%d); "+
			"an unbounded replay write puts %d bytes under one %s deadline, which a slow "+
			"link cannot finish — it reconnects into the identical payload forever",
			largest, replayChunkBytes, total, connWriteTimeout)
	}
	// Chunking must not corrupt or reorder the stream: the banner is queued
	// ahead of history, so it has to arrive first and intact.
	if !strings.HasPrefix(string(received), "BANNER|") {
		t.Errorf("replay did not start with the banner; got %q", string(received[:min(64, len(received))]))
	}
	t.Logf("replay delivered %d bytes in messages of at most %d (chunk cap %d)", total, largest, replayChunkBytes)
}

// The pump must not spend one connWriteTimeout budget on an arbitrarily large
// payload: the minimum throughput a client needs is chunk size / deadline, so
// the chunk cap is what keeps that floor low enough for a slow link.
func TestReplayChunkKeepsThroughputFloorLow(t *testing.T) {
	floorKBps := float64(replayChunkBytes) / connWriteTimeout.Seconds() / 1024
	// 1 MiB under a 15s deadline demands ~68 KB/s, which is what made slow
	// links unrecoverable. Anything above ~10 KB/s is too high a bar.
	if floorKBps > 10 {
		t.Errorf("a client must sustain %.1f KB/s to keep a session attached (chunk=%d, deadline=%s); "+
			"that is too high a floor for a slow tunnel or cellular link",
			floorKBps, replayChunkBytes, connWriteTimeout)
	}
	t.Logf("throughput floor to stay attached: %.1f KB/s", floorKBps)
}
