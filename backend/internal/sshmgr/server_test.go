package sshmgr

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

func TestHandleWSRunsInteractiveShell(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	st := &fakeConnStore{conn: testConn(t, addr)}
	srv := NewServer(NewDialer(st, fakeSecrets{"password": "secret"}))

	httpServer := httptest.NewServer(http.HandlerFunc(srv.HandleWS))
	defer httpServer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "?connection=sc-test&cols=80&rows=24"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial ssh WebSocket: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })

	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"t":"i","d":"LOOM_SSH_ECHO_OK"}`)); err != nil {
		t.Fatalf("write stdin frame: %v", err)
	}
	var output []byte
	for !bytes.Contains(output, []byte("LOOM_SSH_ECHO_OK")) {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read ssh output (got %q so far): %v", output, err)
		}
		output = append(output, data...)
	}
}

func TestHandleWSSurfacesDialErrors(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	st := &fakeConnStore{conn: testConn(t, addr)}
	srv := NewServer(NewDialer(st, fakeSecrets{"password": "wrong"}))

	httpServer := httptest.NewServer(http.HandlerFunc(srv.HandleWS))
	defer httpServer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "?connection=sc-test&cols=80&rows=24"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial ssh WebSocket: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })

	var output []byte
	for !bytes.Contains(output, []byte("[ssh error:")) {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read error frame (got %q so far): %v", output, err)
		}
		output = append(output, data...)
	}
}
