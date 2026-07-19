package terminal

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

func TestHandleWSSpawnsNativeShell(t *testing.T) {
	server := NewServer(nil)
	if !server.ptyOK {
		t.Skip("native PTY is unavailable on this host")
	}

	httpServer := httptest.NewServer(http.HandlerFunc(server.HandleWS))
	defer httpServer.Close()

	session := testSessionID(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	url := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "?session=" + session + "&cols=80&rows=24"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial terminal WebSocket: %v", err)
	}
	t.Cleanup(func() {
		conn.CloseNow()
		_ = KillSession(session)
	})

	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatalf("read terminal banner: %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"t":"i","d":"echo DEVDECK_NATIVE_PTY_OK\r"}`)); err != nil {
		t.Fatalf("write terminal input: %v", err)
	}

	var output []byte
	for !bytes.Contains(output, []byte("DEVDECK_NATIVE_PTY_OK")) {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read terminal output: %v", err)
		}
		output = append(output, data...)
	}
}

func TestHandleWSNotifiesWhenPTYExits(t *testing.T) {
	server := NewServer(nil)
	if !server.ptyOK {
		t.Skip("native PTY is unavailable on this host")
	}

	httpServer := httptest.NewServer(http.HandlerFunc(server.HandleWS))
	defer httpServer.Close()

	session := testSessionID(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	url := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "?session=" + session + "&cols=80&rows=24"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial terminal WebSocket: %v", err)
	}
	t.Cleanup(func() {
		conn.CloseNow()
		_ = KillSession(session)
	})

	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatalf("read terminal banner: %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"t":"i","d":"exit\r"}`)); err != nil {
		t.Fatalf("write terminal exit: %v", err)
	}

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read terminal exit notification: %v", err)
		}
		if typ == websocket.MessageText && string(data) == terminalExitedFrame {
			return
		}
	}
}
