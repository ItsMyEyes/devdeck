// Package codeserver launches on-demand code-server (VS Code in the browser)
// instances rooted at a worktree's working directory, so a worktree card can
// offer a direct "open live code / diff" link without the user managing a
// separate server themselves.
package codeserver

import (
	"errors"
	"fmt"
	"net"
	"os/exec"
	"sync"
	"time"

	"loom/backend/internal/detect"
)

const readyTimeout = 10 * time.Second

// instance is one running code-server process for a single worktree.
type instance struct {
	cmd  *exec.Cmd
	port int
}

// Manager tracks at most one code-server instance per worktree, keyed by
// worktree ID. Instances are started lazily on first request and reused
// until explicitly stopped or the process exits on its own.
type Manager struct {
	mu        sync.Mutex
	instances map[string]*instance
}

// NewManager creates an empty instance registry.
func NewManager() *Manager {
	return &Manager{instances: make(map[string]*instance)}
}

// Start launches (or reuses) a code-server instance rooted at dir for
// worktreeID, and returns the URL to open once it's accepting connections.
// The instance binds to 127.0.0.1 only, with auth disabled — Loom is a
// single-operator local tool, so there's no separate identity to gate a
// password behind, and the port is never exposed beyond loopback.
func (m *Manager) Start(worktreeID, dir string) (string, error) {
	m.mu.Lock()
	if inst, ok := m.instances[worktreeID]; ok {
		m.mu.Unlock()
		return instanceURL(inst.port), nil
	}
	m.mu.Unlock()

	bin, err := detect.ResolveBinary("code-server")
	if err != nil {
		return "", fmt.Errorf("code-server binary not found (install via `npm install -g code-server`): %w", err)
	}

	port, err := freePort()
	if err != nil {
		return "", fmt.Errorf("allocate port: %w", err)
	}

	cmd := exec.Command(bin,
		"--bind-addr", fmt.Sprintf("127.0.0.1:%d", port),
		"--auth", "none",
		"--disable-telemetry",
		"--disable-update-check",
		dir,
	)
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("start code-server: %w", err)
	}

	inst := &instance{cmd: cmd, port: port}
	m.mu.Lock()
	m.instances[worktreeID] = inst
	m.mu.Unlock()

	go func() {
		_ = cmd.Wait()
		m.mu.Lock()
		if current, ok := m.instances[worktreeID]; ok && current == inst {
			delete(m.instances, worktreeID)
		}
		m.mu.Unlock()
	}()

	if err := waitReady(port, readyTimeout); err != nil {
		m.Stop(worktreeID)
		return "", err
	}

	return instanceURL(port), nil
}

// Stop terminates a worktree's running code-server instance, if any. Safe to
// call on a worktree with no running instance (no-op).
func (m *Manager) Stop(worktreeID string) error {
	m.mu.Lock()
	inst, ok := m.instances[worktreeID]
	if ok {
		delete(m.instances, worktreeID)
	}
	m.mu.Unlock()
	if !ok {
		return nil
	}
	if err := inst.cmd.Process.Kill(); err != nil && !errors.Is(err, exec.ErrNotFound) {
		return err
	}
	return nil
}

// Status reports whether a code-server instance is currently running for a
// worktree, and its URL if so.
func (m *Manager) Status(worktreeID string) (url string, running bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	inst, ok := m.instances[worktreeID]
	if !ok {
		return "", false
	}
	return instanceURL(inst.port), true
}

func instanceURL(port int) string {
	return fmt.Sprintf("http://127.0.0.1:%d/", port)
}

// freePort asks the OS for an ephemeral loopback port, then releases it
// immediately so code-server can bind it — there's an inherent (tiny) race
// between release and code-server's own bind, same tradeoff every "find a
// free port" helper makes.
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// waitReady polls the port until it accepts a TCP connection, so the caller
// only gets a URL back once code-server is actually ready to serve it.
func waitReady(port int, timeout time.Duration) error {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("code-server did not become ready on port %d within %s", port, timeout)
}
