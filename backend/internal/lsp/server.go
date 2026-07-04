// Package lsp bridges browser WebSockets to local Language Server Protocol
// processes. Each connection owns one server process rooted at its worktree.
package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"loom/backend/internal/detect"
	gitpkg "loom/backend/internal/git"
	"loom/backend/internal/port"

	"nhooyr.io/websocket"
)

const maxMessageSize = 16 << 20

type serverSpec struct {
	binary string
	args   []string
}

var languageServers = map[string]serverSpec{
	"go":              {binary: "gopls"},
	"javascript":      {binary: "typescript-language-server", args: []string{"--stdio"}},
	"javascriptreact": {binary: "typescript-language-server", args: []string{"--stdio"}},
	"python":          {binary: "pyright-langserver", args: []string{"--stdio"}},
	"rust":            {binary: "rust-analyzer"},
	"typescript":      {binary: "typescript-language-server", args: []string{"--stdio"}},
	"typescriptreact": {binary: "typescript-language-server", args: []string{"--stdio"}},
}

// Server creates scoped local language-server processes for worktrees.
type Server struct {
	store port.Store
}

func NewServer(store port.Store) *Server {
	return &Server{store: store}
}

// HandleWS upgrades /ws/lsp and proxies JSON-RPC messages to a language server.
func (s *Server) HandleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionContextTakeover,
	})
	if err != nil {
		log.Printf("lsp: websocket accept: %v", err)
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(maxMessageSize)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	worktreeID := strings.TrimSpace(r.URL.Query().Get("worktree"))
	language := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("language")))
	spec, ok := languageServers[language]
	if !ok {
		s.closeWithError(ctx, conn, fmt.Sprintf("language %q is not supported", language))
		return
	}
	root, err := s.worktreeRoot(worktreeID)
	if err != nil {
		s.closeWithError(ctx, conn, err.Error())
		return
	}
	binary, err := detect.ResolveBinary(spec.binary)
	if err != nil {
		s.closeWithError(ctx, conn, fmt.Sprintf("%s is not installed", spec.binary))
		return
	}

	cmd := exec.CommandContext(ctx, binary, spec.args...)
	cmd.Dir = root
	stdin, err := cmd.StdinPipe()
	if err != nil {
		s.closeWithError(ctx, conn, fmt.Sprintf("open %s stdin: %v", spec.binary, err))
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.closeWithError(ctx, conn, fmt.Sprintf("open %s stdout: %v", spec.binary, err))
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		s.closeWithError(ctx, conn, fmt.Sprintf("open %s stderr: %v", spec.binary, err))
		return
	}
	if err := cmd.Start(); err != nil {
		s.closeWithError(ctx, conn, fmt.Sprintf("start %s: %v", spec.binary, err))
		return
	}

	rootURI := fileURI(root)
	if err := writeControl(ctx, conn, controlMessage{
		Type:     "ready",
		Language: language,
		RootURI:  rootURI,
	}); err != nil {
		cancel()
		_ = cmd.Wait()
		return
	}

	log.Printf("lsp: started %s for worktree %s (%s)", spec.binary, worktreeID, root)
	go logStderr(spec.binary, worktreeID, stderr)

	serverDone := make(chan error, 1)
	go func() {
		serverDone <- forwardServer(ctx, conn, stdout)
		cancel()
	}()

	clientErr := forwardClient(ctx, conn, stdin)
	cancel()
	_ = stdin.Close()
	serverErr := <-serverDone
	waitErr := cmd.Wait()

	if clientErr != nil && !expectedClose(clientErr) {
		log.Printf("lsp: %s client stream for %s: %v", spec.binary, worktreeID, clientErr)
	}
	if serverErr != nil && !errors.Is(serverErr, io.EOF) && !errors.Is(serverErr, context.Canceled) {
		log.Printf("lsp: %s server stream for %s: %v", spec.binary, worktreeID, serverErr)
	}
	if waitErr != nil && ctx.Err() == nil {
		log.Printf("lsp: %s exited for %s: %v", spec.binary, worktreeID, waitErr)
	}
}

func (s *Server) worktreeRoot(worktreeID string) (string, error) {
	if s.store == nil || worktreeID == "" {
		return "", errors.New("worktree is required")
	}
	worktree, err := s.store.WorktreeByID(worktreeID)
	if err != nil {
		return "", fmt.Errorf("worktree %q was not found", worktreeID)
	}
	project, err := s.store.ProjectByID(worktree.ProjectID)
	if err != nil {
		return "", fmt.Errorf("project for worktree %q was not found", worktreeID)
	}
	return resolveWorktreeRoot(project.Path, worktreeID, worktree.Root, worktree.Branch)
}

func resolveWorktreeRoot(projectPath, worktreeID string, root bool, branch string) (string, error) {
	path := gitpkg.ExpandHome(projectPath)
	if !root && branch != "" {
		path = filepath.Join(path, ".wt", worktreeID)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve worktree path: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", fmt.Errorf("resolve worktree path: %w", err)
	}
	return resolved, nil
}

func forwardClient(ctx context.Context, conn *websocket.Conn, dst io.Writer) error {
	for {
		messageType, payload, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		if messageType != websocket.MessageText || !json.Valid(payload) {
			return errors.New("LSP messages must be JSON text")
		}
		if err := writeFrame(dst, payload); err != nil {
			return err
		}
	}
}

func forwardServer(ctx context.Context, conn *websocket.Conn, src io.Reader) error {
	reader := bufio.NewReader(src)
	for {
		payload, err := readFrame(reader)
		if err != nil {
			return err
		}
		if err := conn.Write(ctx, websocket.MessageText, payload); err != nil {
			return err
		}
	}
}

func writeFrame(w io.Writer, payload []byte) error {
	if len(payload) > maxMessageSize {
		return fmt.Errorf("LSP message exceeds %d bytes", maxMessageSize)
	}
	if _, err := fmt.Fprintf(w, "Content-Length: %d\r\n\r\n", len(payload)); err != nil {
		return err
	}
	written, err := w.Write(payload)
	if err == nil && written != len(payload) {
		return io.ErrShortWrite
	}
	return err
}

func readFrame(reader *bufio.Reader) ([]byte, error) {
	contentLength := -1
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok || !strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			continue
		}
		contentLength, err = strconv.Atoi(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("invalid Content-Length: %w", err)
		}
	}
	if contentLength < 0 {
		return nil, errors.New("LSP frame has no Content-Length")
	}
	if contentLength > maxMessageSize {
		return nil, fmt.Errorf("LSP message exceeds %d bytes", maxMessageSize)
	}
	payload := make([]byte, contentLength)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

type controlMessage struct {
	Type     string `json:"type"`
	Message  string `json:"message,omitempty"`
	Language string `json:"language,omitempty"`
	RootURI  string `json:"rootUri,omitempty"`
}

func writeControl(ctx context.Context, conn *websocket.Conn, message controlMessage) error {
	payload, err := json.Marshal(struct {
		LoomLSP controlMessage `json:"loomLsp"`
	}{LoomLSP: message})
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, payload)
}

func (s *Server) closeWithError(ctx context.Context, conn *websocket.Conn, message string) {
	_ = writeControl(ctx, conn, controlMessage{Type: "error", Message: message})
	_ = conn.Close(websocket.StatusPolicyViolation, message)
}

func fileURI(path string) string {
	slashed := filepath.ToSlash(path)
	if runtime.GOOS == "windows" && !strings.HasPrefix(slashed, "/") {
		slashed = "/" + slashed
	}
	return (&url.URL{Scheme: "file", Path: slashed}).String()
}

func logStderr(binary, worktreeID string, stderr io.Reader) {
	scanner := bufio.NewScanner(stderr)
	for scanner.Scan() {
		log.Printf("lsp: %s[%s]: %s", binary, worktreeID, scanner.Text())
	}
}

func expectedClose(err error) bool {
	status := websocket.CloseStatus(err)
	return status == websocket.StatusNormalClosure ||
		status == websocket.StatusGoingAway ||
		errors.Is(err, context.Canceled)
}
