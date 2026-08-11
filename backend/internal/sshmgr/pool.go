package sshmgr

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// filePoolIdleTTL bounds how long an unused SSH+SFTP pair is kept warm. The
// file explorer issues many short REST calls per connection (unlike the
// shell, which dials once per WebSocket) so redialing on every request would
// make browsing feel sluggish; caching for a while amortizes the handshake
// cost across a browsing session without holding connections open forever.
const filePoolIdleTTL = 10 * time.Minute

// filePoolReapInterval is how often the background reaper sweeps for entries
// past filePoolIdleTTL.
const filePoolReapInterval = 2 * time.Minute

// FilePool caches one SSH+SFTP client pair per connection id for
// SSHFileService. Entries are torn down and transparently re-dialed on the
// next use once idle-expired or explicitly evicted after a request observes
// a dead connection.
type FilePool struct {
	dialer *Dialer

	mu      sync.Mutex
	entries map[string]*filePoolEntry

	closeOnce sync.Once
	// done is closed by Close to stop reapLoop's background goroutine, which
	// otherwise runs for the life of the process with nothing able to stop
	// it — a problem for a clean shutdown path that must not leave dangling
	// SSH/SFTP connections (or goroutines) behind after the server exits.
	done chan struct{}
}

// filePoolEntry caches one connectionID's live SSH client plus, lazily, its
// paired SFTP session: sftp starts nil and is only opened the first time
// something actually needs it (Get). GetSSH's exec-primitive callers
// (WithSSHClient, RunCommand) never need SFTP, so they share the same
// entry's ssh client without paying for a subsystem handshake they don't
// use.
type filePoolEntry struct {
	ssh  *ssh.Client
	sftp *sftp.Client
	// home caches the SFTP session's initial working directory (see Home).
	// Empty until first resolved; scoped to this entry, so an evicted and
	// re-dialed connection re-resolves it instead of inheriting a stale value.
	home     string
	lastUsed time.Time
}

func (e *filePoolEntry) close() {
	if e.sftp != nil {
		_ = e.sftp.Close()
	}
	_ = e.ssh.Close()
}

func NewFilePool(dialer *Dialer) *FilePool {
	pool := &FilePool{
		dialer:  dialer,
		entries: make(map[string]*filePoolEntry),
		done:    make(chan struct{}),
	}
	go pool.reapLoop()
	return pool
}

func (p *FilePool) reapLoop() {
	ticker := time.NewTicker(filePoolReapInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			p.reapIdle()
		case <-p.done:
			return
		}
	}
}

// Close stops the background reaper and closes every pooled entry, so a
// clean shutdown doesn't leave live SSH/SFTP connections (or the reaper
// goroutine) running past the server exiting. Safe to call more than once —
// only the first call does anything.
func (p *FilePool) Close() {
	p.closeOnce.Do(func() {
		close(p.done)

		p.mu.Lock()
		entries := make([]*filePoolEntry, 0, len(p.entries))
		for id, entry := range p.entries {
			entries = append(entries, entry)
			delete(p.entries, id)
		}
		p.mu.Unlock()

		for _, entry := range entries {
			entry.close()
		}
	})
}

func (p *FilePool) reapIdle() {
	p.mu.Lock()
	var expired []*filePoolEntry
	for id, entry := range p.entries {
		if time.Since(entry.lastUsed) >= filePoolIdleTTL {
			expired = append(expired, entry)
			delete(p.entries, id)
		}
	}
	p.mu.Unlock()
	for _, entry := range expired {
		entry.close()
	}
}

// GetSSH returns a live *ssh.Client for connectionID, reusing a cached
// entry's SSH half when one exists or dialing fresh otherwise. Unlike Get,
// this never triggers an SFTP subsystem handshake — callers that only need
// to run commands (WithSSHClient, RunCommand) share the same pooled
// transport Get's SFTP clients ride on, without paying for a capability
// they don't use.
func (p *FilePool) GetSSH(ctx context.Context, connectionID string) (*ssh.Client, error) {
	p.mu.Lock()
	if entry, ok := p.entries[connectionID]; ok {
		entry.lastUsed = time.Now()
		client := entry.ssh
		p.mu.Unlock()
		return client, nil
	}
	p.mu.Unlock()

	sshClient, err := p.dialer.Dial(ctx, connectionID)
	if err != nil {
		return nil, err
	}

	p.mu.Lock()
	if existing, ok := p.entries[connectionID]; ok {
		// Lost a race with a concurrent GetSSH/Get for the same connection
		// — keep the one already installed and close the redundant dial.
		p.mu.Unlock()
		_ = sshClient.Close()
		existing.lastUsed = time.Now()
		return existing.ssh, nil
	}
	p.entries[connectionID] = &filePoolEntry{ssh: sshClient, lastUsed: time.Now()}
	p.mu.Unlock()
	return sshClient, nil
}

// Get returns a live *sftp.Client for connectionID, reusing a cached one
// when its entry already has it, opening the SFTP subsystem lazily on top
// of GetSSH's (possibly freshly dialed, possibly reused) SSH client
// otherwise.
func (p *FilePool) Get(ctx context.Context, connectionID string) (*sftp.Client, error) {
	sshClient, err := p.GetSSH(ctx, connectionID)
	if err != nil {
		return nil, err
	}

	p.mu.Lock()
	if entry, ok := p.entries[connectionID]; ok && entry.ssh == sshClient && entry.sftp != nil {
		client := entry.sftp
		entry.lastUsed = time.Now()
		p.mu.Unlock()
		return client, nil
	}
	p.mu.Unlock()

	sftpClient, err := sftp.NewClient(sshClient)
	if err != nil {
		return nil, fmt.Errorf("open sftp session: %w", err)
	}

	p.mu.Lock()
	entry, ok := p.entries[connectionID]
	if !ok || entry.ssh != sshClient {
		// The ssh client we opened this sftp session against was
		// evicted/replaced (e.g. a concurrent Evict) while we were
		// mid-handshake — drop the now-orphaned sftp client rather than
		// attaching it to an entry it doesn't belong to; the caller
		// (WithSFTPClient) will see this as an ordinary error, not a
		// connection error, so it isn't auto-retried, but the next request
		// dials fresh normally.
		p.mu.Unlock()
		_ = sftpClient.Close()
		return nil, fmt.Errorf("sshmgr: pooled connection %s changed while opening sftp session", connectionID)
	}
	if entry.sftp != nil {
		// Lost a race with a concurrent Get for the same connection.
		p.mu.Unlock()
		_ = sftpClient.Close()
		entry.lastUsed = time.Now()
		return entry.sftp, nil
	}
	entry.sftp = sftpClient
	entry.lastUsed = time.Now()
	p.mu.Unlock()
	return sftpClient, nil
}

// Home returns connectionID's remote home directory — the SFTP session's
// initial working directory, which is the root every SSHFileService path is
// resolved against. It is resolved once per live connection and cached on
// the pool entry: it cannot change while a connection is up, whereas the
// SFTP REALPATH round trip it costs was previously paid on *every* file
// operation (list a folder, open a file, save, rename, ...), which is a
// whole extra round trip per request on a high-latency link.
//
// The cache is keyed to the specific *sftp.Client it was resolved from, so
// an evicted-and-redialed connection (possibly a different user or host
// after the connection was edited) always re-resolves rather than reusing
// the previous connection's home.
func (p *FilePool) Home(ctx context.Context, connectionID string) (string, error) {
	client, err := p.Get(ctx, connectionID)
	if err != nil {
		return "", err
	}

	p.mu.Lock()
	if entry, ok := p.entries[connectionID]; ok && entry.sftp == client && entry.home != "" {
		home := entry.home
		entry.lastUsed = time.Now()
		p.mu.Unlock()
		return home, nil
	}
	p.mu.Unlock()

	home, err := client.Getwd()
	if err != nil {
		return "", err
	}

	p.mu.Lock()
	if entry, ok := p.entries[connectionID]; ok && entry.sftp == client {
		entry.home = home
		entry.lastUsed = time.Now()
	}
	p.mu.Unlock()
	return home, nil
}

// Evict closes and drops connectionID's cached pair, if any, so the next
// Get dials fresh. Called after an operation observes the connection is
// dead (see isConnectionError).
func (p *FilePool) Evict(connectionID string) {
	p.mu.Lock()
	entry, ok := p.entries[connectionID]
	if ok {
		delete(p.entries, connectionID)
	}
	p.mu.Unlock()
	if ok {
		entry.close()
	}
}

// isConnectionError distinguishes a dead transport (worth evicting + one
// redial-and-retry) from an ordinary SFTP protocol error such as "file not
// found" or "permission denied" (worth returning to the caller as-is).
func isConnectionError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, sftp.ErrSSHFxConnectionLost) {
		return true
	}
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) || errors.Is(err, net.ErrClosed)
}

// WithSFTPClient runs fn against connectionID's pooled client, evicting and
// retrying exactly once if fn's error looks like a dead connection (see
// isConnectionError) rather than an ordinary SFTP failure (not found,
// permission denied, ...), which is returned to the caller as-is.
func WithSFTPClient[T any](ctx context.Context, pool *FilePool, connectionID string, fn func(*sftp.Client) (T, error)) (T, error) {
	var zero T
	client, err := pool.Get(ctx, connectionID)
	if err != nil {
		return zero, err
	}
	result, err := fn(client)
	if err == nil || !isConnectionError(err) {
		return result, err
	}
	pool.Evict(connectionID)
	client, err = pool.Get(ctx, connectionID)
	if err != nil {
		return zero, err
	}
	return fn(client)
}
