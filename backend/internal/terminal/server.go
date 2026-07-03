package terminal

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"loom/backend/internal/detect"
	"loom/backend/internal/port"

	"nhooyr.io/websocket"
)

var ansi = struct {
	Reset  string
	Dim    string
	Blue   string
	Green  string
	Yellow string
	Red    string
	Purple string
	Gray   string
}{
	Reset:  "\x1b[0m",
	Dim:    "\x1b[38;5;244m",
	Blue:   "\x1b[38;5;111m",
	Green:  "\x1b[38;5;114m",
	Yellow: "\x1b[38;5;222m",
	Red:    "\x1b[38;5;210m",
	Purple: "\x1b[38;5;183m",
	Gray:   "\x1b[38;5;102m",
}

// Server manages WebSocket terminal connections.
type Server struct {
	mu       sync.Mutex
	ptyOK    bool
	store    port.Store
	registry *registry
}

// NewServer creates a terminal WebSocket server. Pass the store so the terminal
// can look up worktree metadata and auto-launch agent commands.
func NewServer(store port.Store) *Server {
	s := &Server{ptyOK: ptyAvailable(), store: store, registry: newRegistry()}
	activeRegistry = s.registry
	if s.ptyOK {
		log.Println("terminal: PTY available")
	} else {
		log.Println("terminal: PTY unavailable — terminal spawning disabled")
	}
	return s
}

// HandleWS handles a WebSocket upgrade request at /ws/terminal.
func (s *Server) HandleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		// Terminal output is highly repetitive ANSI text; the shared
		// sliding window compresses it heavily, which matters most when
		// production is reached through a tunnel. Clients that don't
		// support it (e.g. Safari) simply fall back to uncompressed.
		CompressionMode: websocket.CompressionContextTakeover,
	})
	if err != nil {
		log.Printf("terminal: websocket accept: %v", err)
		return
	}
	defer conn.CloseNow()
	// Default read limit is 32 KB, which fails the connection on a large
	// paste into the terminal.
	conn.SetReadLimit(1 << 20)

	q := r.URL.Query()
	session := q.Get("session")
	if session == "" {
		session = "session"
	}
	cols := clampInt(q.Get("cols"), 80, 1, 500)
	rows := clampInt(q.Get("rows"), 24, 1, 300)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Resolve agent command for worktree sessions
	agentBin, args, workDir := s.resolveCommand(session)

	if s.ptyOK {
		if err := s.attachPTY(ctx, conn, session, cols, rows, agentBin, workDir, args); err != nil {
			log.Printf("terminal: pty session %s failed: %v", session, err)
			writeText(ctx, conn, fmt.Sprintf("\r\n%s[terminal error: %v]%s\r\n", ansi.Red, err, ansi.Reset))
		}
	} else {
		log.Printf("terminal: PTY unavailable — falling back to simulated session %s", session)
		s.attachMock(ctx, conn, session)
	}
}

// resolveCommand looks up a worktree by session ID and returns the agent binary,
// arguments, and working directory. Returns empty strings if not a worktree session.
func (s *Server) resolveCommand(session string) (agentBin string, args []string, workDir string) {
	if s.store == nil || !strings.HasPrefix(session, "w-") {
		return "", nil, ""
	}

	wt, err := s.store.WorktreeByID(session)
	if err != nil {
		return "", nil, ""
	}

	proj, err := s.store.ProjectByID(wt.ProjectID)
	if err != nil {
		return "", nil, ""
	}

	// workDir is computed regardless of whether an agent resolves below, so a
	// root-mode session with no agent (plain shell) still opens in the
	// project root rather than falling back to the user's home directory.
	workDir = proj.Path
	// For branch mode, use the worktree directory
	if !wt.Root && wt.Branch != "" {
		workDir = filepath.Join(proj.Path, ".wt", session)
	}

	// wt.Agent is the agent ID chosen at worktree creation (e.g. "codex"),
	// resolved to an absolute path so the launch doesn't depend on the
	// spawned shell's PATH (which may not match the backend process's own
	// environment). This used to be guessed by prefix-matching wt.Model
	// against known agent IDs, which only worked for Claude by coincidence
	// (its model IDs happen to start with "claude-") — every other agent's
	// models (e.g. codex's "gpt-5") never matched, silently falling back to
	// a plain shell instead of launching the agent.
	if wt.Agent == "" {
		return "", nil, workDir
	}
	resolved, err := detect.Resolve(wt.Agent)
	if err != nil {
		log.Printf("terminal: session %s: %v", session, err)
		return "", nil, workDir
	}
	agentBin = resolved

	task := strings.TrimSpace(wt.Task)
	if task != "" {
		args = []string{"-p", task}
	}

	return agentBin, args, workDir
}

func pickShell() string {
	if runtime.GOOS == "windows" {
		for _, shell := range []string{"pwsh.exe", "powershell.exe"} {
			if resolved, err := exec.LookPath(shell); err == nil {
				return resolved
			}
		}
		if shell := os.Getenv("COMSPEC"); shell != "" {
			if _, err := os.Stat(shell); err == nil {
				return shell
			}
		}
		if resolved, err := exec.LookPath("cmd.exe"); err == nil {
			return resolved
		}
		return "cmd.exe"
	}

	// Try $SHELL first, then common paths, then LookPath.
	if p := os.Getenv("SHELL"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	for _, s := range []string{"/bin/zsh", "/bin/bash", "/bin/sh"} {
		if _, err := os.Stat(s); err == nil {
			return s
		}
	}
	// Fall back to PATH lookup for sh
	if p, err := exec.LookPath("sh"); err == nil {
		return p
	}
	return "/bin/sh"
}

func clampInt(raw string, dflt, min, max int) int {
	n, err := strconv.Atoi(raw)
	if err != nil {
		return dflt
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

type frame struct {
	T    string `json:"t"`
	D    string `json:"d,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

func writeText(ctx context.Context, conn *websocket.Conn, s string) {
	_ = conn.Write(ctx, websocket.MessageText, []byte(s))
}

func bannerText(session, shell string, isPTY bool) string {
	mode := "simulated agent"
	if isPTY {
		mode = fmt.Sprintf("live PTY · %s", shell)
	}
	return fmt.Sprintf("%sloom terminal · session %s · %s%s\r\n\r\n",
		ansi.Dim, session, mode, ansi.Reset)
}

func writeBanner(ctx context.Context, conn *websocket.Conn, session, shell string, isPTY bool) {
	writeText(ctx, conn, bannerText(session, shell, isPTY))
}

// Keepalive sends pings every 30s and terminates dead connections.
func keepalive(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := conn.Ping(ctx); err != nil {
				return
			}
		}
	}
}
