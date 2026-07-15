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
}

type filePoolEntry struct {
	ssh      *ssh.Client
	sftp     *sftp.Client
	lastUsed time.Time
}

func (e *filePoolEntry) close() {
	_ = e.sftp.Close()
	_ = e.ssh.Close()
}

func NewFilePool(dialer *Dialer) *FilePool {
	pool := &FilePool{dialer: dialer, entries: make(map[string]*filePoolEntry)}
	go pool.reapLoop()
	return pool
}

func (p *FilePool) reapLoop() {
	ticker := time.NewTicker(filePoolReapInterval)
	defer ticker.Stop()
	for range ticker.C {
		p.reapIdle()
	}
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

// Get returns a live *sftp.Client for connectionID, reusing a cached pair
// when one exists or dialing (and running the SFTP subsystem handshake)
// fresh otherwise.
func (p *FilePool) Get(ctx context.Context, connectionID string) (*sftp.Client, error) {
	p.mu.Lock()
	if entry, ok := p.entries[connectionID]; ok {
		entry.lastUsed = time.Now()
		client := entry.sftp
		p.mu.Unlock()
		return client, nil
	}
	p.mu.Unlock()

	sshClient, err := p.dialer.Dial(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	sftpClient, err := sftp.NewClient(sshClient)
	if err != nil {
		sshClient.Close()
		return nil, fmt.Errorf("open sftp session: %w", err)
	}

	p.mu.Lock()
	if existing, ok := p.entries[connectionID]; ok {
		// Lost a race with a concurrent Get for the same connection — keep
		// the one already installed and close the redundant pair.
		p.mu.Unlock()
		_ = sftpClient.Close()
		_ = sshClient.Close()
		existing.lastUsed = time.Now()
		return existing.sftp, nil
	}
	p.entries[connectionID] = &filePoolEntry{ssh: sshClient, sftp: sftpClient, lastUsed: time.Now()}
	p.mu.Unlock()
	return sftpClient, nil
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
