package terminal

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"nhooyr.io/websocket"
)

var kindAnsi = map[string]string{
	"cmd":  ansi.Blue,
	"out":  ansi.Dim,
	"ok":   ansi.Green,
	"warn": ansi.Yellow,
	"err":  ansi.Red,
	"sys":  ansi.Gray,
	"file": ansi.Purple,
}

var mockPool = []struct{ kind, text string }{
	{"sys", "● thinking…"},
	{"file", "edit  src/server/auth/jwt.ts (+18 −4)"},
	{"out", "ran tool: read_file package.json"},
	{"cmd", "$ pnpm test -- auth.spec.ts"},
	{"ok", "✓ 23 passed (3.1s)"},
	{"out", "typechecking… 412 files"},
	{"warn", "⚠ unused export \"legacyVerify\""},
	{"file", "create src/server/auth/rotate.ts"},
	{"ok", "✓ lint clean — 0 problems"},
	{"sys", "● searching codebase: \"verifyToken\""},
	{"out", "7 matches across 5 files"},
}

// attachMock runs a simulated agent stream when PTY is unavailable.
func (s *Server) attachMock(ctx context.Context, conn *websocket.Conn, session string) {
	log.Printf("terminal: session %s mock stream started", session)
	writeBanner(ctx, conn, session, "", false)

	go keepalive(ctx, conn)

	// Periodic mock output
	ticker := time.NewTicker(1600 * time.Millisecond)
	defer ticker.Stop()
	i := 0

	// Prompt
	writeText(ctx, conn, fmt.Sprintf("\r\n%sdevdeck:%s%s %s›%s ",
		ansi.Green, session, ansi.Reset, ansi.Blue, ansi.Reset))

	buf := strings.Builder{}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m := mockPool[i%len(mockPool)]
			i++
			k := kindAnsi[m.kind]
			if k == "" {
				k = ansi.Dim
			}
			writeText(ctx, conn, fmt.Sprintf("%s%s%s\r\n", k, m.text, ansi.Reset))

			// Write prompt after most lines
			if i%3 != 0 {
				writeText(ctx, conn, fmt.Sprintf("%sdevdeck:%s%s %s›%s %s",
					ansi.Green, session, ansi.Reset, ansi.Blue, ansi.Reset, buf.String()))
			}
		default:
			// Read from WebSocket
			_, msg, err := conn.Read(ctx)
			if err != nil {
				log.Printf("terminal: session %s mock closed", session)
				return
			}
			var f frame
			if err := json.Unmarshal(msg, &f); err != nil {
				continue
			}
			if f.T != "i" {
				continue
			}
			for _, ch := range f.D {
				if ch == '\r' {
					cmd := strings.TrimSpace(buf.String())
					buf.Reset()
					writeText(ctx, conn, "\r\n")
					if cmd != "" {
						writeText(ctx, conn, fmt.Sprintf("%srunning: %s%s\r\n", ansi.Dim, cmd, ansi.Reset))
						writeText(ctx, conn, fmt.Sprintf("%s✓ done%s\r\n", ansi.Green, ansi.Reset))
					}
					writeText(ctx, conn, fmt.Sprintf("%sdevdeck:%s%s %s›%s ",
						ansi.Green, session, ansi.Reset, ansi.Blue, ansi.Reset))
				} else if ch == '\x7f' {
					s := buf.String()
					if len(s) > 0 {
						buf.Reset()
						buf.WriteString(s[:len(s)-1])
						writeText(ctx, conn, "\b \b")
					}
				} else {
					buf.WriteRune(ch)
					writeText(ctx, conn, string(ch))
				}
			}
		}
	}
}
