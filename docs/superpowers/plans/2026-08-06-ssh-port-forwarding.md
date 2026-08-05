# SSH Port Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saved `-L` / `-R` / `-D` forwarding rules per SSH connection, each with an explicit start/stop toggle, a live status, and automatic reconnection when the transport drops.

**Architecture:** The hub owns saved rules in a new `ssh_forwards` table. The executor owns live listeners in memory, keyed by rule id, started by pushing the whole rule in the request body — so `CatalogSnapshot` is untouched. Each active forward holds its own dedicated `*ssh.Client` (never the idle-reaping `FilePool`) under a supervisor goroutine implementing an explicit state machine.

**Tech Stack:** Go 1.26, `golang.org/x/crypto/ssh`, existing `internal/netproxy` SOCKS5 codec, SQLite via `internal/store`, React 19 + TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-ssh-port-forwarding-design.md`

## Global Constraints

- All API responses use the `{"error":"message"}` envelope via `writeErr` / `writeJSON`; store errors go through `handleStoreErr`.
- All persistence goes through `port.Store`.
- `frontend/src/store/types.ts` and `backend/internal/domain/models.go` must stay in sync.
- Frontend imports use `@/*`; `import type` for type-only imports. Icons `lucide-react`; toasts `sonner`; `cn()` for classes.
- Every data surface renders explicit loading, error, and empty states.
- **New frontend test files must be added to `test.include` in `frontend/vite.config.ts`.**
- Status values are exactly `off` | `starting` | `running` | `reconnecting` | `failed`. Mode values are exactly `local` | `remote` | `dynamic`. Use these strings verbatim on both sides.
- Backoff: exponential from **1s**, doubling, capped at **30s**.
- **Convergence files:** `backend/internal/domain/models.go`, `backend/internal/port/store.go`, `backend/cmd/server/main.go`, `frontend/src/store/types.ts`. This plan is sequential.
- Verify with `npm run typecheck` (frontend) and `go vet ./...` (backend).

---

### Task 1: Domain types, table, and store CRUD

**Files:**
- Modify: `backend/internal/domain/models.go`
- Modify: `backend/internal/store/db.go` (table after `ssh_secrets` ~line 221)
- Create: `backend/internal/store/sshforward.go`
- Test: `backend/internal/store/sshforward_test.go` (create)
- Modify: `backend/internal/port/store.go`
- Modify: `frontend/src/store/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `domain.SSHForward`, `domain.SSHForwardState`; `Store.SSHForwards(connectionID)`, `SSHForwardByID(id)`, `CreateSSHForward(...)`, `UpdateSSHForward(id, port.SSHForwardPatch)`, `DeleteSSHForward(id)`; TS mirrors. Tasks 4-6 consume these.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/store/sshforward_test.go`:

```go
package store

import "testing"

func newForwardTestConnection(t *testing.T, s *Store) string {
	t.Helper()
	conn, err := s.CreateSSHConnection("web", "", "example.com", 22, "root", "password", nil, nil)
	if err != nil {
		t.Fatalf("CreateSSHConnection: %v", err)
	}
	return conn.ID
}

func TestCreateAndListSSHForwards(t *testing.T) {
	s := newTestStore(t)
	connID := newForwardTestConnection(t, s)

	fwd, err := s.CreateSSHForward(connID, "local", "127.0.0.1", 5432, "db.internal", 5432, "prod db")
	if err != nil {
		t.Fatalf("CreateSSHForward: %v", err)
	}
	if fwd.ID == "" {
		t.Fatal("CreateSSHForward returned an empty id")
	}
	if fwd.Mode != "local" || fwd.BindPort != 5432 || fwd.TargetHost != "db.internal" {
		t.Fatalf("unexpected round-trip: %+v", fwd)
	}

	list, err := s.SSHForwards(connID)
	if err != nil {
		t.Fatalf("SSHForwards: %v", err)
	}
	if len(list) != 1 || list[0].ID != fwd.ID {
		t.Fatalf("SSHForwards = %+v, want the one created rule", list)
	}
}

func TestSSHForwardsAreScopedToTheirConnection(t *testing.T) {
	s := newTestStore(t)
	a := newForwardTestConnection(t, s)
	b := newForwardTestConnection(t, s)

	if _, err := s.CreateSSHForward(a, "local", "127.0.0.1", 5432, "db", 5432, ""); err != nil {
		t.Fatal(err)
	}

	list, err := s.SSHForwards(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("connection b sees %d rules from connection a", len(list))
	}
}

func TestUpdateSSHForward(t *testing.T) {
	s := newTestStore(t)
	connID := newForwardTestConnection(t, s)
	fwd, err := s.CreateSSHForward(connID, "local", "127.0.0.1", 5432, "db", 5432, "")
	if err != nil {
		t.Fatal(err)
	}

	got, err := s.UpdateSSHForward(fwd.ID, forwardPatch(6543, "renamed"))
	if err != nil {
		t.Fatalf("UpdateSSHForward: %v", err)
	}
	if got.BindPort != 6543 || got.Label != "renamed" {
		t.Fatalf("patch not applied: %+v", got)
	}
	if got.TargetHost != "db" {
		t.Errorf("unpatched field changed: TargetHost = %q, want \"db\"", got.TargetHost)
	}
}

func TestDeleteSSHForward(t *testing.T) {
	s := newTestStore(t)
	connID := newForwardTestConnection(t, s)
	fwd, err := s.CreateSSHForward(connID, "dynamic", "127.0.0.1", 1081, "", 0, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteSSHForward(fwd.ID); err != nil {
		t.Fatalf("DeleteSSHForward: %v", err)
	}
	if _, err := s.SSHForwardByID(fwd.ID); err == nil {
		t.Fatal("SSHForwardByID succeeded after delete")
	}
}

func TestDeletingConnectionCascadesToForwards(t *testing.T) {
	s := newTestStore(t)
	connID := newForwardTestConnection(t, s)
	fwd, err := s.CreateSSHForward(connID, "local", "127.0.0.1", 5432, "db", 5432, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteSSHConnection(connID); err != nil {
		t.Fatalf("DeleteSSHConnection: %v", err)
	}
	if _, err := s.SSHForwardByID(fwd.ID); err == nil {
		t.Fatal("forward survived its connection being deleted; the FK cascade is not working")
	}
}
```

Add a small helper in the same file so the patch construction is readable:

```go
func forwardPatch(bindPort int, label string) port.SSHForwardPatch {
	return port.SSHForwardPatch{BindPort: &bindPort, Label: &label}
}
```

and import `"devdeck/backend/internal/port"`.

Verify `CreateSSHConnection`'s real signature in `backend/internal/store/ssh.go` before running — it is `CreateSSHConnection(name, group, host string, portNum int, username, authType string, jumpConnectionID, executorMachineID *string)`. Adjust the helper if it differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/store/ -run SSHForward -v`
Expected: FAIL — `CreateSSHForward` undefined.

- [ ] **Step 3: Add the domain types**

In `backend/internal/domain/models.go`, after `SSHSecret`:

```go
// SSHForward is one saved port-forwarding rule on an SSH connection.
// Mode is "local" (-L), "remote" (-R) or "dynamic" (-D).
type SSHForward struct {
	ID           string `json:"id"`
	ConnectionID string `json:"connectionId"`
	Mode         string `json:"mode"`
	BindHost     string `json:"bindHost"`
	BindPort     int    `json:"bindPort"`
	// TargetHost/TargetPort are empty/zero for mode "dynamic", which has no
	// single target — each proxied connection carries its own.
	TargetHost string `json:"targetHost"`
	TargetPort int    `json:"targetPort"`
	Label      string `json:"label"`
}

// SSHForwardState is a forward's live status. In-memory only, never
// persisted: a restart legitimately returns every forward to "off", since
// forwards do not autostart.
type SSHForwardState struct {
	ForwardID string `json:"forwardId"`
	// Status is "off" | "starting" | "running" | "reconnecting" | "failed".
	Status    string `json:"status"`
	BoundAddr string `json:"boundAddr,omitempty"`
	Error     string `json:"error,omitempty"`
	Attempts  int    `json:"attempts"`
}
```

- [ ] **Step 4: Add the table**

In `backend/internal/store/db.go`, after the `ssh_secrets` table:

```sql
-- Saved port-forwarding rules. The hub owns these; the executor holds only
-- the live listeners, in memory. ON DELETE CASCADE mirrors ssh_secrets: a
-- forwarding rule has no meaning without its connection.
CREATE TABLE IF NOT EXISTS ssh_forwards (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES ssh_connections(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL DEFAULT 'local',
  bind_host     TEXT NOT NULL DEFAULT '127.0.0.1',
  bind_port     INTEGER NOT NULL DEFAULT 0,
  target_host   TEXT NOT NULL DEFAULT '',
  target_port   INTEGER NOT NULL DEFAULT 0,
  label         TEXT NOT NULL DEFAULT ''
);
```

`CREATE TABLE IF NOT EXISTS` covers both fresh and existing databases here — unlike a new *column*, a new *table* needs no `ALTER`. Confirm foreign keys are enabled on the connection (`PRAGMA foreign_keys = ON`) in `Open`; if they are not, the cascade test in Step 1 will fail and the pragma must be added.

- [ ] **Step 5: Write the store CRUD**

Create `backend/internal/store/sshforward.go` following the shape of `backend/internal/store/ssh.go` exactly — read that file first and mirror its scanning, id generation (`idGen`), and error handling. It must implement:

```go
func (s *Store) SSHForwards(connectionID string) ([]domain.SSHForward, error)
func (s *Store) SSHForwardByID(id string) (domain.SSHForward, error)
func (s *Store) CreateSSHForward(connectionID, mode, bindHost string, bindPort int, targetHost string, targetPort int, label string) (domain.SSHForward, error)
func (s *Store) UpdateSSHForward(id string, p port.SSHForwardPatch) (domain.SSHForward, error)
func (s *Store) DeleteSSHForward(id string) error
```

`SSHForwards` orders by `mode, bind_port` so the UI list is stable across reloads. `SSHForwardByID` returns the same not-found error value `SSHConnectionByID` returns, so `handleStoreErr` maps it to a 404 identically.

- [ ] **Step 6: Add the patch type and interface methods**

In `backend/internal/port/store.go`, next to `SSHConnectionPatch`:

```go
// SSHForwardPatch carries optional fields for a partial forwarding-rule
// update. A nil pointer means "not provided" and leaves the column alone.
type SSHForwardPatch struct {
	Mode       *string
	BindHost   *string
	BindPort   *int
	TargetHost *string
	TargetPort *int
	Label      *string
}
```

And in the `Store` interface, next to the SSH connection methods:

```go
	// SSH port-forwarding rules (hub-owned; the executor holds only live
	// listeners, in memory).
	SSHForwards(connectionID string) ([]domain.SSHForward, error)
	SSHForwardByID(id string) (domain.SSHForward, error)
	CreateSSHForward(connectionID, mode, bindHost string, bindPort int, targetHost string, targetPort int, label string) (domain.SSHForward, error)
	UpdateSSHForward(id string, p SSHForwardPatch) (domain.SSHForward, error)
	DeleteSSHForward(id string) error
```

- [ ] **Step 7: Add the TS mirrors**

In `frontend/src/store/types.ts`, next to `SSHConnection`:

```ts
export type SSHForwardMode = 'local' | 'remote' | 'dynamic'

/** Mirror of backend/internal/domain/SSHForward — one saved forwarding rule. */
export interface SSHForward {
  id: string
  connectionId: string
  mode: SSHForwardMode
  bindHost: string
  bindPort: number
  /** Empty/zero for mode 'dynamic', which has no single target. */
  targetHost: string
  targetPort: number
  label: string
}

export type SSHForwardStatus = 'off' | 'starting' | 'running' | 'reconnecting' | 'failed'

/** Mirror of backend/internal/domain/SSHForwardState — live, never persisted. */
export interface SSHForwardState {
  forwardId: string
  status: SSHForwardStatus
  boundAddr?: string
  error?: string
  attempts: number
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd backend && go test ./internal/store/ -run SSHForward -v && go vet ./... && cd ../frontend && npm run typecheck`
Expected: 5 tests PASS, vet and typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add backend/internal/domain/models.go backend/internal/store/db.go \
        backend/internal/store/sshforward.go backend/internal/store/sshforward_test.go \
        backend/internal/port/store.go frontend/src/store/types.ts
git commit -m "feat(ssh): add ssh_forwards table and forwarding-rule CRUD"
```

---

### Task 2: netproxy — export `Relay`, add `SOCKS5Server.DialContext`

**Files:**
- Modify: `backend/internal/netproxy/socks5.go`
- Modify: `backend/internal/netproxy/httpproxy.go` (call site of `relay`)
- Test: `backend/internal/netproxy/socks5_dialer_test.go` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `netproxy.Relay(a, b net.Conn)`; `(*SOCKS5Server).DialContext` field of type `func(ctx context.Context, network, addr string) (net.Conn, error)`. Task 3 consumes both.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/netproxy/socks5_dialer_test.go`:

```go
package netproxy

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

// socks5Handshake performs greeting + no-auth + CONNECT and returns the reply.
func socks5Handshake(t *testing.T, conn net.Conn, host string, port uint16) byte {
	t.Helper()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatalf("greeting: %v", err)
	}
	sel := make([]byte, 2)
	if _, err := io.ReadFull(conn, sel); err != nil {
		t.Fatalf("method selection: %v", err)
	}
	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len(host))}
	req = append(req, []byte(host)...)
	req = binary.BigEndian.AppendUint16(req, port)
	if _, err := conn.Write(req); err != nil {
		t.Fatalf("connect request: %v", err)
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatalf("connect reply: %v", err)
	}
	return reply[1]
}

func TestSOCKS5UsesCustomDialContext(t *testing.T) {
	// Upstream that announces itself, so we can prove the tunnel is real.
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		for {
			c, err := upstream.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte("hello"))
			c.Close()
		}
	}()

	var used atomic.Int32
	srv := NewSOCKS5Server("")
	srv.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		used.Add(1)
		// Ignore the requested addr entirely and dial our upstream: proves
		// the custom dialer is what actually establishes the connection.
		return net.Dial(network, upstream.Addr().String())
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() { _ = srv.Serve(ln) }()

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if code := socks5Handshake(t, conn, "ignored.invalid", 9999); code != 0x00 {
		t.Fatalf("CONNECT reply = %#x, want 0x00", code)
	}
	if used.Load() == 0 {
		t.Fatal("custom DialContext was never called")
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read through tunnel: %v", err)
	}
	if string(buf) != "hello" {
		t.Errorf("read %q through the tunnel, want \"hello\"", buf)
	}
}

func TestSOCKS5DefaultDialerStillWorks(t *testing.T) {
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		for {
			c, err := upstream.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()

	srv := NewSOCKS5Server("") // no DialContext set
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() { _ = srv.Serve(ln) }()

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	host, portStr, _ := net.SplitHostPort(upstream.Addr().String())
	var port uint16
	_, _ = fmtSscan(portStr, &port)
	if code := socks5Handshake(t, conn, host, port); code != 0x00 {
		t.Errorf("CONNECT reply = %#x, want 0x00 with the default dialer", code)
	}
}

// fmtSscan keeps the import list small in this test file.
func fmtSscan(s string, out *uint16) (int, error) {
	var v int
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, nil
		}
		v = v*10 + int(r-'0')
	}
	*out = uint16(v)
	return 1, nil
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/netproxy/ -run 'DialContext|DefaultDialer' -v`
Expected: FAIL — `srv.DialContext` undefined.

- [ ] **Step 3: Add the DialContext field**

In `backend/internal/netproxy/socks5.go`, extend the struct and its use:

```go
type SOCKS5Server struct {
	authKey string
	dialer  net.Dialer
	// DialContext, when set, establishes every proxied connection instead of
	// the default net.Dialer. SSH dynamic forwarding (-D) sets it to dial
	// through an ssh.Client, reusing this file's protocol codec without its
	// direct-dial activation model.
	DialContext func(ctx context.Context, network, addr string) (net.Conn, error)
}
```

In `handleConn`, replace the dial:

```go
	dial := s.DialContext
	if dial == nil {
		dial = s.dialer.DialContext
	}
	upstream, dialErr := dial(context.Background(), "tcp", target)
```

Add `"context"` to the imports.

- [ ] **Step 4: Export Relay**

Rename `relay` to `Relay` with an exported doc comment, and update its two call sites (`socks5.go:103` and `httpproxy.go:94`):

```go
// Relay pipes data between two established connections until either side
// closes, half-closing the write side of each so a one-directional EOF (e.g.
// an HTTP client done sending) doesn't stall the other direction.
//
// Exported because SSH port forwarding needs exactly this behaviour for all
// three of its modes; a second copy of it in sshmgr would be a second copy of
// subtle code that has already been gotten right once.
func Relay(a, b net.Conn) {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/netproxy/ -v && go build ./... && go vet ./...`
Expected: the 2 new tests PASS, all pre-existing netproxy tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/netproxy/
git commit -m "feat(netproxy): export Relay and add SOCKS5Server.DialContext"
```

---

### Task 3: Extend the test SSH server for remote forwarding

`-R` needs the `tcpip-forward` global request and `forwarded-tcpip` channels, which `startTestSSHServer` does not implement today (it handles only `session` and `direct-tcpip`). Without this, Task 5's `-R` test cannot exist.

**Files:**
- Modify: `backend/internal/sshmgr/testserver_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: a test SSH server that honours `tcpip-forward` by opening a real local listener and pushing accepted connections back as `forwarded-tcpip` channels. Task 5's `-R` test depends on it.

- [ ] **Step 1: Add the RFC 4254 §7.1 payload types**

In `backend/internal/sshmgr/testserver_test.go`, next to `directTCPIPMsg`:

```go
// tcpipForwardMsg mirrors RFC 4254 §7.1's "tcpip-forward" global request —
// what ssh.Client.Listen sends to ask the server to listen on its side.
type tcpipForwardMsg struct {
	BindAddr string
	BindPort uint32
}

// tcpipForwardReply is the port the server actually bound, returned when the
// request asked for port 0.
type tcpipForwardReply struct {
	BoundPort uint32
}

// forwardedTCPIPMsg mirrors RFC 4254 §7.2's "forwarded-tcpip" channel-open
// extra data — what the server sends for each connection it accepts on a
// forwarded port.
type forwardedTCPIPMsg struct {
	DestAddr   string
	DestPort   uint32
	OrigAddr   string
	OrigPort   uint32
}
```

- [ ] **Step 2: Handle the global request**

`serveTestSSHConn` currently does `go ssh.DiscardRequests(reqs)`. Replace that with a handler that services `tcpip-forward` and discards everything else:

```go
	go serveTestGlobalRequests(sc, reqs)
```

And add:

```go
// serveTestGlobalRequests honours "tcpip-forward" (what -R needs) by opening
// a real listener on this process and pushing each accepted connection back
// to the client as a "forwarded-tcpip" channel, the way a real sshd does.
func serveTestGlobalRequests(sc *ssh.ServerConn, reqs <-chan *ssh.Request) {
	for req := range reqs {
		if req.Type != "tcpip-forward" {
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
			continue
		}
		var msg tcpipForwardMsg
		if err := ssh.Unmarshal(req.Payload, &msg); err != nil {
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
			continue
		}
		ln, err := net.Listen("tcp", net.JoinHostPort(msg.BindAddr, fmt.Sprint(msg.BindPort)))
		if err != nil {
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
			continue
		}
		bound := uint32(ln.Addr().(*net.TCPAddr).Port)
		if req.WantReply {
			_ = req.Reply(true, ssh.Marshal(tcpipForwardReply{BoundPort: bound}))
		}
		go serveTestForwardedListener(sc, ln, msg.BindAddr, bound)
	}
}

func serveTestForwardedListener(sc *ssh.ServerConn, ln net.Listener, bindAddr string, boundPort uint32) {
	defer ln.Close()
	for {
		nc, err := ln.Accept()
		if err != nil {
			return
		}
		payload := ssh.Marshal(forwardedTCPIPMsg{
			DestAddr: bindAddr, DestPort: boundPort,
			OrigAddr: "127.0.0.1", OrigPort: 0,
		})
		ch, reqs, err := sc.OpenChannel("forwarded-tcpip", payload)
		if err != nil {
			nc.Close()
			continue
		}
		go ssh.DiscardRequests(reqs)
		go func() {
			_, _ = io.Copy(ch, nc)
			_ = ch.Close()
		}()
		go func() {
			_, _ = io.Copy(nc, ch)
			_ = nc.Close()
		}()
	}
}
```

- [ ] **Step 3: Verify no existing test regressed**

Run: `cd backend && go test ./internal/sshmgr/ -v`
Expected: every pre-existing sshmgr test still PASSES. This task adds capability only; a failure here means the global-request change broke the shell or SFTP paths.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/sshmgr/testserver_test.go
git commit -m "test(sshmgr): support tcpip-forward in the in-process test server"
```

---

### Task 4: The Forwarder — `-L` and `-D`

**Files:**
- Create: `backend/internal/sshmgr/forward.go`
- Test: `backend/internal/sshmgr/forward_test.go` (create)

**Interfaces:**
- Consumes: `netproxy.Relay`, `SOCKS5Server.DialContext` (Task 2); the test server (Task 3); existing `Dialer.Dial`.
- Produces: `sshmgr.NewForwarder(dialer *Dialer) *Forwarder`, `(*Forwarder).Start(rule domain.SSHForward) (domain.SSHForwardState, error)`, `Stop(forwardID string) error`, `States() []domain.SSHForwardState`, `StateOf(forwardID string) domain.SSHForwardState`. Tasks 5 and 6 consume all of them.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/sshmgr/forward_test.go`. Follow how `dialer_test.go` builds its `fakeConnStore` / `fakeSecrets` — read it first and reuse those exact fakes:

```go
package sshmgr

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"

	"devdeck/backend/internal/domain"
)

// newForwardTestDialer wires a Dialer at an in-process SSH server.
func newForwardTestDialer(t *testing.T) (*Dialer, string) {
	t.Helper()
	addr, fingerprint := startTestSSHServer(t, nil)
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	port := 0
	for _, r := range portStr {
		port = port*10 + int(r-'0')
	}
	fp := fingerprint
	conn := domain.SSHConnection{
		ID: "c1", Host: host, Port: port, Username: "tester",
		AuthType: "password", HostKeyFingerprint: &fp,
	}
	store := &fakeConnStore{conn: conn}
	return NewDialer(store, fakeSecrets{"c1:password": "secret"}), "c1"
}

// echoServer accepts connections and echoes everything back.
func echoServer(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	return ln
}

func waitForStatus(t *testing.T, f *Forwarder, id, want string) domain.SSHForwardState {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last domain.SSHForwardState
	for time.Now().Before(deadline) {
		last = f.StateOf(id)
		if last.Status == want {
			return last
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("status = %q (err %q), want %q", last.Status, last.Error, want)
	return last
}

func TestLocalForwardPipesBytes(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	target := echoServer(t)
	targetHost, targetPortStr, _ := net.SplitHostPort(target.Addr().String())
	targetPort := 0
	for _, r := range targetPortStr {
		targetPort = targetPort*10 + int(r-'0')
	}

	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("f1") })

	rule := domain.SSHForward{
		ID: "f1", ConnectionID: connID, Mode: "local",
		BindHost: "127.0.0.1", BindPort: 0,
		TargetHost: targetHost, TargetPort: targetPort,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatalf("Start: %v", err)
	}
	state := waitForStatus(t, f, "f1", "running")

	conn, err := net.Dial("tcp", state.BoundAddr)
	if err != nil {
		t.Fatalf("dial forward: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf) != "ping" {
		t.Errorf("read %q, want \"ping\"", buf)
	}
}

func TestStopClosesTheListener(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	target := echoServer(t)
	targetHost, targetPortStr, _ := net.SplitHostPort(target.Addr().String())
	targetPort := 0
	for _, r := range targetPortStr {
		targetPort = targetPort*10 + int(r-'0')
	}

	f := NewForwarder(dialer)
	rule := domain.SSHForward{
		ID: "f1", ConnectionID: connID, Mode: "local",
		BindHost: "127.0.0.1", BindPort: 0,
		TargetHost: targetHost, TargetPort: targetPort,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatal(err)
	}
	state := waitForStatus(t, f, "f1", "running")

	if err := f.Stop("f1"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if _, err := net.DialTimeout("tcp", state.BoundAddr, time.Second); err == nil {
		t.Error("forward port still accepts connections after Stop")
	}
	if got := f.StateOf("f1").Status; got != "off" {
		t.Errorf("status after Stop = %q, want \"off\"", got)
	}
}

func TestStopIsIdempotent(t *testing.T) {
	dialer, _ := newForwardTestDialer(t)
	f := NewForwarder(dialer)

	if err := f.Stop("never-started"); err != nil {
		t.Errorf("Stop on an unknown id returned %v, want nil", err)
	}
}

func TestDynamicForwardProxiesThroughSSH(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	target := echoServer(t)

	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("d1") })

	rule := domain.SSHForward{
		ID: "d1", ConnectionID: connID, Mode: "dynamic",
		BindHost: "127.0.0.1", BindPort: 0,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatalf("Start: %v", err)
	}
	state := waitForStatus(t, f, "d1", "running")

	conn, err := net.Dial("tcp", state.BoundAddr)
	if err != nil {
		t.Fatalf("dial socks: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))

	// Greeting + no auth.
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	sel := make([]byte, 2)
	if _, err := io.ReadFull(conn, sel); err != nil {
		t.Fatal(err)
	}
	host, portStr, _ := net.SplitHostPort(target.Addr().String())
	port := 0
	for _, r := range portStr {
		port = port*10 + int(r-'0')
	}
	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len(host))}
	req = append(req, []byte(host)...)
	req = binary.BigEndian.AppendUint16(req, uint16(port))
	if _, err := conn.Write(req); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatal(err)
	}
	if reply[1] != 0x00 {
		t.Fatalf("SOCKS reply = %#x, want 0x00", reply[1])
	}
	if _, err := conn.Write([]byte("pong")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "pong" {
		t.Errorf("read %q through the SOCKS tunnel, want \"pong\"", buf)
	}
}

func TestStartRejectsInvalidRule(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	f := NewForwarder(dialer)

	for name, rule := range map[string]domain.SSHForward{
		"unknown mode": {ID: "x", ConnectionID: connID, Mode: "sideways", BindPort: 1},
		"local without target": {
			ID: "x", ConnectionID: connID, Mode: "local", BindPort: 1,
		},
		"port out of range": {
			ID: "x", ConnectionID: connID, Mode: "dynamic", BindPort: 70000,
		},
	} {
		if _, err := f.Start(rule); err == nil {
			t.Errorf("%s: Start accepted an invalid rule", name)
		}
	}
}

func TestStartFailsTerminallyOnBadConnection(t *testing.T) {
	dialer, _ := newForwardTestDialer(t)
	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("bad") })

	rule := domain.SSHForward{
		ID: "bad", ConnectionID: "no-such-connection", Mode: "dynamic",
		BindHost: "127.0.0.1", BindPort: 0,
	}
	// Start may return the error directly or drive the supervisor to failed;
	// either is acceptable, but it must not sit in "reconnecting" forever.
	if _, err := f.Start(rule); err != nil {
		return
	}
	state := waitForStatus(t, f, "bad", "failed")
	if state.Error == "" {
		t.Error("failed state carries no error message")
	}
}

func TestLocalForwardSurvivesADeadTarget(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("f2") })

	// Port 9 (discard) on a host that refuses: every proxied connection fails.
	rule := domain.SSHForward{
		ID: "f2", ConnectionID: connID, Mode: "local",
		BindHost: "127.0.0.1", BindPort: 0,
		TargetHost: "127.0.0.1", TargetPort: 1,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatal(err)
	}
	state := waitForStatus(t, f, "f2", "running")

	// A failed proxied connection must not tear the forward down.
	for i := 0; i < 3; i++ {
		if c, err := net.DialTimeout("tcp", state.BoundAddr, time.Second); err == nil {
			_, _ = io.Copy(io.Discard, c)
			c.Close()
		}
	}
	if got := f.StateOf("f2").Status; got != "running" {
		t.Errorf("status = %q after failed proxied connections, want \"running\"", got)
	}
}

func TestStatesListsEveryActiveForward(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	f := NewForwarder(dialer)
	t.Cleanup(func() {
		_ = f.Stop("a")
		_ = f.Stop("b")
	})

	for _, id := range []string{"a", "b"} {
		rule := domain.SSHForward{
			ID: id, ConnectionID: connID, Mode: "dynamic",
			BindHost: "127.0.0.1", BindPort: 0,
		}
		if _, err := f.Start(rule); err != nil {
			t.Fatalf("Start %s: %v", id, err)
		}
	}
	waitForStatus(t, f, "a", "running")
	waitForStatus(t, f, "b", "running")

	states := f.States()
	if len(states) != 2 {
		t.Fatalf("States() returned %d entries, want 2", len(states))
	}
}

var _ = context.Background // keep the import if unused after edits
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/sshmgr/ -run 'Forward|Stop|States|Dynamic' -v`
Expected: FAIL — `NewForwarder` undefined.

- [ ] **Step 3: Write the forwarder**

Create `backend/internal/sshmgr/forward.go`:

```go
package sshmgr

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/netproxy"
)

// Forwarder owns every live port-forwarding listener on this machine.
//
// Rules are the hub's; only the listeners are ours, and only in memory —
// a restart legitimately returns every forward to "off", since forwards do
// not autostart. Start therefore takes the whole rule rather than an id:
// the executor never reads it from a local store, which is what keeps
// forwarding out of CatalogSnapshot entirely.
type Forwarder struct {
	dialer *Dialer

	mu     sync.Mutex
	active map[string]*activeForward
}

type activeForward struct {
	rule   domain.SSHForward
	state  domain.SSHForwardState
	client *ssh.Client
	ln     net.Listener
	cancel context.CancelFunc
}

func NewForwarder(dialer *Dialer) *Forwarder {
	return &Forwarder{dialer: dialer, active: map[string]*activeForward{}}
}

// Start validates the rule and launches its supervisor. Starting an id that
// is already active stops the old one first, so editing a running rule never
// leaves two listeners fighting over a port.
func (f *Forwarder) Start(rule domain.SSHForward) (domain.SSHForwardState, error) {
	if err := validateForward(rule); err != nil {
		return domain.SSHForwardState{}, err
	}
	_ = f.Stop(rule.ID)

	ctx, cancel := context.WithCancel(context.Background())
	entry := &activeForward{
		rule:   rule,
		cancel: cancel,
		state:  domain.SSHForwardState{ForwardID: rule.ID, Status: "starting"},
	}

	f.mu.Lock()
	f.active[rule.ID] = entry
	f.mu.Unlock()

	go f.supervise(ctx, rule)
	return entry.state, nil
}

// Stop tears a forward down without touching the saved rule. Idempotent: an
// unknown or already-stopped id is a success, so a double-click or a stale
// UI cannot produce an error the operator has to think about.
func (f *Forwarder) Stop(forwardID string) error {
	f.mu.Lock()
	entry, ok := f.active[forwardID]
	if ok {
		delete(f.active, forwardID)
	}
	f.mu.Unlock()
	if !ok {
		return nil
	}
	entry.cancel()
	if entry.ln != nil {
		_ = entry.ln.Close()
	}
	if entry.client != nil {
		_ = entry.client.Close()
	}
	return nil
}

// StateOf reports one forward's live status; an unknown id is "off".
func (f *Forwarder) StateOf(forwardID string) domain.SSHForwardState {
	f.mu.Lock()
	defer f.mu.Unlock()
	if entry, ok := f.active[forwardID]; ok {
		return entry.state
	}
	return domain.SSHForwardState{ForwardID: forwardID, Status: "off"}
}

// States reports every forward this machine is currently holding.
func (f *Forwarder) States() []domain.SSHForwardState {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]domain.SSHForwardState, 0, len(f.active))
	for _, entry := range f.active {
		out = append(out, entry.state)
	}
	return out
}

func (f *Forwarder) setState(forwardID string, mutate func(*domain.SSHForwardState)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if entry, ok := f.active[forwardID]; ok {
		mutate(&entry.state)
	}
}

// supervise runs one forward's whole lifetime: dial, bind, serve, and — when
// the transport dies — back off and do it again. It exits only on Stop
// (ctx cancelled) or a terminal error.
func (f *Forwarder) supervise(ctx context.Context, rule domain.SSHForward) {
	attempt := 0
	for {
		if ctx.Err() != nil {
			return
		}

		dead, err := f.runOnce(ctx, rule)
		if err != nil {
			if ctx.Err() != nil {
				return // Stop raced us; not a failure worth reporting
			}
			if isTerminalForwardErr(err) {
				// A revoked key or a taken port will never fix itself.
				// Retrying would hide a dead rule behind a hopeful
				// "reconnecting" forever.
				f.setState(rule.ID, func(s *domain.SSHForwardState) {
					s.Status = "failed"
					s.Error = err.Error()
					s.Attempts = attempt
				})
				return
			}
			f.setState(rule.ID, func(s *domain.SSHForwardState) {
				s.Status = "reconnecting"
				s.Error = err.Error()
				s.Attempts = attempt
			})
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoffFor(attempt)):
			}
			attempt++
			continue
		}

		// Bound and serving. Reset the counter so a link that flaps once an
		// hour recovers in 1s every time instead of drifting to the 30s cap.
		attempt = 0
		select {
		case <-ctx.Done():
			return
		case <-dead:
			f.setState(rule.ID, func(s *domain.SSHForwardState) {
				s.Status = "reconnecting"
				s.BoundAddr = ""
			})
		}
	}
}

// runOnce dials, binds, and starts serving. It returns a channel closed when
// the transport dies, so the supervisor can wait without polling.
func (f *Forwarder) runOnce(ctx context.Context, rule domain.SSHForward) (<-chan struct{}, error) {
	client, err := f.dialer.Dial(ctx, rule.ConnectionID)
	if err != nil {
		return nil, err
	}

	ln, err := f.listenFor(rule, client)
	if err != nil {
		_ = client.Close()
		return nil, err
	}

	f.mu.Lock()
	entry, ok := f.active[rule.ID]
	if !ok {
		// Stopped while we were dialing — drop what we just built rather
		// than leaking a listener nothing will ever close.
		f.mu.Unlock()
		_ = ln.Close()
		_ = client.Close()
		return nil, context.Canceled
	}
	entry.client = client
	entry.ln = ln
	entry.state.Status = "running"
	entry.state.Error = ""
	entry.state.BoundAddr = ln.Addr().String()
	f.mu.Unlock()

	go f.serve(rule, client, ln)

	dead := make(chan struct{})
	go func() {
		client.Wait()
		_ = ln.Close() // stop accepting into a transport that is gone
		close(dead)
	}()
	return dead, nil
}

// isTerminalForwardErr distinguishes "this will never work" from "the network
// blipped". Only the latter is worth retrying.
func isTerminalForwardErr(err error) bool {
	if errors.Is(err, ErrHostKeyChanged) || errors.Is(err, ErrJumpChainCycle) {
		return true
	}
	msg := strings.ToLower(err.Error())
	for _, terminal := range []string{
		"unable to authenticate", "no stored password", "no stored private key",
		"parse private key", "unsupported auth type", "address already in use",
		"not found", "no such",
	} {
		if strings.Contains(msg, terminal) {
			return true
		}
	}
	return false
}
```

Then add `listenFor` and `serve`, which switch on the mode using the wiring given below.

**Dedicated client, never `FilePool`:** `FilePool` reaps idle entries after `filePoolIdleTTL` (10 minutes), and an idle tunnel is exactly an idle entry — pooling would silently kill working forwards. That is why `runOnce` calls `f.dialer.Dial` directly and holds the result.

Validation, called by `Start`:

```go
func validateForward(rule domain.SSHForward) error {
	switch rule.Mode {
	case "local", "remote":
		if rule.TargetHost == "" || rule.TargetPort <= 0 || rule.TargetPort > 65535 {
			return fmt.Errorf("mode %s requires a target host and port", rule.Mode)
		}
	case "dynamic":
		if rule.TargetHost != "" || rule.TargetPort != 0 {
			return fmt.Errorf("mode dynamic takes no target: each proxied connection carries its own")
		}
	default:
		return fmt.Errorf("unknown forward mode %q", rule.Mode)
	}
	if rule.BindPort < 0 || rule.BindPort > 65535 {
		return fmt.Errorf("bind port %d is out of range (0-65535)", rule.BindPort)
	}
	return nil
}
```

Per-mode wiring for `listenFor` (which returns the listener) and `serve`
(which accepts on it). `dynamic` has no accept loop of its own — the SOCKS5
server owns it:

```go
// local (-L): listen here, dial the target through the SSH client.
ln, err := net.Listen("tcp", net.JoinHostPort(rule.BindHost, strconv.Itoa(rule.BindPort)))
// per accepted conn:
remote, err := client.Dial("tcp", net.JoinHostPort(rule.TargetHost, strconv.Itoa(rule.TargetPort)))
if err != nil {
    accepted.Close() // one dead target must not tear the forward down
    continue
}
go netproxy.Relay(accepted, remote)

// remote (-R): listen on the remote host, dial the target from here.
ln, err := client.Listen("tcp", net.JoinHostPort(rule.BindHost, strconv.Itoa(rule.BindPort)))
// per accepted conn:
local, err := net.DialTimeout("tcp", net.JoinHostPort(rule.TargetHost, strconv.Itoa(rule.TargetPort)), 10*time.Second)
if err != nil {
    accepted.Close()
    continue
}
go netproxy.Relay(accepted, local)

// dynamic (-D): listen here, serve SOCKS5 whose CONNECTs go through SSH.
ln, err := net.Listen("tcp", net.JoinHostPort(rule.BindHost, strconv.Itoa(rule.BindPort)))
srv := netproxy.NewSOCKS5Server("")
srv.DialContext = func(_ context.Context, network, addr string) (net.Conn, error) {
    return client.Dial(network, addr)
}
go srv.Serve(ln)
```

`BoundAddr` comes from `ln.Addr().String()` so a `BindPort: 0` rule reports the port the OS actually assigned.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/sshmgr/ -race -run 'Forward|Stop|States|Dynamic' -v`
Expected: all PASS, no race. (`TestRemoteForward*` arrives in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add backend/internal/sshmgr/forward.go backend/internal/sshmgr/forward_test.go
git commit -m "feat(sshmgr): add Forwarder with local and dynamic port forwarding"
```

---

### Task 5: Remote forwarding and the reconnect state machine

**Files:**
- Modify: `backend/internal/sshmgr/forward.go`
- Modify: `backend/internal/sshmgr/forward_test.go`

**Interfaces:**
- Consumes: everything from Task 4; the extended test server from Task 3.
- Produces: working `mode: "remote"`, plus `backoffFor(attempt int) time.Duration` (unexported, tested directly).

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/sshmgr/forward_test.go`:

```go
func TestRemoteForwardPipesBytes(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	target := echoServer(t)
	targetHost, targetPortStr, _ := net.SplitHostPort(target.Addr().String())
	targetPort := 0
	for _, r := range targetPortStr {
		targetPort = targetPort*10 + int(r-'0')
	}

	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("r1") })

	rule := domain.SSHForward{
		ID: "r1", ConnectionID: connID, Mode: "remote",
		BindHost: "127.0.0.1", BindPort: 0,
		TargetHost: targetHost, TargetPort: targetPort,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatalf("Start: %v", err)
	}
	state := waitForStatus(t, f, "r1", "running")

	// The test server bound a real local listener for the remote side, so
	// dialing BoundAddr enters the tunnel from the "remote" end.
	conn, err := net.Dial("tcp", state.BoundAddr)
	if err != nil {
		t.Fatalf("dial remote-forward port: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte("back")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "back" {
		t.Errorf("read %q, want \"back\"", buf)
	}
}

func TestBackoffSequence(t *testing.T) {
	want := []time.Duration{
		1 * time.Second,
		2 * time.Second,
		4 * time.Second,
		8 * time.Second,
		16 * time.Second,
		30 * time.Second, // capped
		30 * time.Second,
		30 * time.Second,
	}
	for i, w := range want {
		if got := backoffFor(i); got != w {
			t.Errorf("backoffFor(%d) = %v, want %v", i, got, w)
		}
	}
}

func TestBackoffNeverExceedsCap(t *testing.T) {
	for attempt := 0; attempt < 100; attempt++ {
		if got := backoffFor(attempt); got > 30*time.Second {
			t.Fatalf("backoffFor(%d) = %v, exceeds the 30s cap", attempt, got)
		}
	}
}

func TestForwardReconnectsAfterTransportDies(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	target := echoServer(t)
	targetHost, targetPortStr, _ := net.SplitHostPort(target.Addr().String())
	targetPort := 0
	for _, r := range targetPortStr {
		targetPort = targetPort*10 + int(r-'0')
	}

	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("rc") })

	rule := domain.SSHForward{
		ID: "rc", ConnectionID: connID, Mode: "local",
		BindHost: "127.0.0.1", BindPort: 0,
		TargetHost: targetHost, TargetPort: targetPort,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, f, "rc", "running")

	// Kill the underlying transport out from under the forward.
	f.closeClientForTest("rc")

	// It must come back on its own, not sit dead.
	waitForStatus(t, f, "rc", "running")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/sshmgr/ -run 'RemoteForward|Backoff|Reconnects' -v`
Expected: FAIL — `backoffFor` and `closeClientForTest` undefined, remote mode unimplemented.

- [ ] **Step 3: Implement backoff, remote mode, and the test hook**

In `backend/internal/sshmgr/forward.go`:

```go
const (
	forwardBackoffBase = time.Second
	forwardBackoffCap  = 30 * time.Second
)

// backoffFor returns the delay before retry number `attempt` (0-based):
// 1s, 2s, 4s, 8s, 16s, then capped at 30s. Exponential so a briefly-flapping
// link recovers fast, capped so a long outage doesn't drift into hours.
func backoffFor(attempt int) time.Duration {
	d := forwardBackoffBase << attempt
	// The shift overflows into a negative duration well before attempt 63.
	if d <= 0 || d > forwardBackoffCap {
		return forwardBackoffCap
	}
	return d
}

// closeClientForTest kills a forward's transport so the reconnect path can be
// exercised. Test-only; not part of the public surface.
func (f *Forwarder) closeClientForTest(forwardID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if a, ok := f.active[forwardID]; ok && a.client != nil {
		_ = a.client.Close()
	}
}
```

Add the `"remote"` case to the mode switch using the `client.Listen` wiring given in Task 4 Step 3.

The supervisor must notice the client dying. Use `client.Wait()` in a goroutine to signal the loop, and reset the attempt counter to 0 after a connection has stayed up — otherwise a link that flaps once an hour eventually waits 30s to recover from every blip.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/sshmgr/ -race -v`
Expected: every sshmgr test PASSES, including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/sshmgr/forward.go backend/internal/sshmgr/forward_test.go
git commit -m "feat(sshmgr): add remote forwarding and reconnect backoff"
```

---

### Task 6: Handlers and wiring

**Files:**
- Create: `backend/internal/handler/sshforward.go`
- Test: `backend/internal/handler/sshforward_test.go` (create)
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: store CRUD (Task 1); `Forwarder` (Tasks 4-5).
- Produces: `handler.NewSSHForwardHandler(st port.Store, fwd *sshmgr.Forwarder) *SSHForwardHandler` with `GetForConnection`, `Post`, `Patch`, `Delete`, `PostStart`, `PostStop`, `GetStates`; the seven routes. Task 7 consumes the routes.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/handler/sshforward_test.go`. Test the rule-CRUD half against a store (the lifecycle half is covered by Task 4-5's real integration tests):

```go
package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"devdeck/backend/internal/domain"
)

func TestPostForwardRejectsUnknownMode(t *testing.T) {
	h := newTestSSHForwardHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/ssh/connections/c1/forwards",
		strings.NewReader(`{"mode":"sideways","bindHost":"127.0.0.1","bindPort":1080}`))
	req.SetPathValue("id", "c1")

	h.Post(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	_ = json.NewDecoder(rec.Body).Decode(&body)
	if body["error"] == "" {
		t.Error("missing the {\"error\":...} envelope")
	}
}

func TestPostForwardRejectsLocalWithoutTarget(t *testing.T) {
	h := newTestSSHForwardHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/ssh/connections/c1/forwards",
		strings.NewReader(`{"mode":"local","bindHost":"127.0.0.1","bindPort":5432}`))
	req.SetPathValue("id", "c1")

	h.Post(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}

func TestPostForwardRejectsDynamicWithTarget(t *testing.T) {
	h := newTestSSHForwardHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/ssh/connections/c1/forwards",
		strings.NewReader(`{"mode":"dynamic","bindHost":"127.0.0.1","bindPort":1081,"targetHost":"db","targetPort":5432}`))
	req.SetPathValue("id", "c1")

	h.Post(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}

func TestPostForwardDefaultsBindHostToLoopback(t *testing.T) {
	h := newTestSSHForwardHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/ssh/connections/c1/forwards",
		strings.NewReader(`{"mode":"local","bindPort":5432,"targetHost":"db","targetPort":5432}`))
	req.SetPathValue("id", "c1")

	h.Post(rec, req)

	if rec.Code != http.StatusOK && rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body domain.SSHForward
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.BindHost != "127.0.0.1" {
		t.Errorf("BindHost = %q, want the loopback default", body.BindHost)
	}
}

func TestGetForConnectionReturnsEmptyArrayNotNull(t *testing.T) {
	h := newTestSSHForwardHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/ssh/connections/c1/forwards", nil)
	req.SetPathValue("id", "c1")

	h.GetForConnection(rec, req)

	if got := strings.TrimSpace(rec.Body.String()); got != "[]" {
		t.Errorf("body = %s, want [] (a null breaks the frontend's .map)", got)
	}
}
```

Write `newTestSSHForwardHandler(t)` to build the handler over a real `store.New(Open(t.TempDir()/...))` with one seeded SSH connection `c1`, mirroring how other handler tests in this package construct a store. Read an existing handler test that needs a store (e.g. `backend/internal/handler/ssh_file_test.go`) and follow its setup exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run Forward -v`
Expected: FAIL — `newTestSSHForwardHandler` / `NewSSHForwardHandler` undefined.

- [ ] **Step 3: Write the handler**

Create `backend/internal/handler/sshforward.go` implementing the seven methods. Requirements:

- `Post` and `Patch` validate before writing, with the same rules as `sshmgr.validateForward` plus a default of `127.0.0.1` for an omitted `bindHost`. Validation lives on both sides deliberately: a rule can be edited between the write and the start.
- `GetForConnection` returns `[]` rather than `null` for no rules.
- `Delete` stops the forward before deleting the row.
- `Patch` stops and restarts a running forward, so the live listener always matches the saved rule.
- `PostStart` decodes a full `domain.SSHForward` from the body and calls `Forwarder.Start` — the executor never reads the rule from its own store, which is what keeps `CatalogSnapshot` out of this feature.
- Store errors go through `handleStoreErr`; validation errors are `writeErr(w, http.StatusBadRequest, ...)`.

- [ ] **Step 4: Wire it in main.go**

Construct near `sshFileSvc` (~line 359):

```go
	sshForwarder := sshmgr.NewForwarder(sshDialer)
	sshForwardH := handler.NewSSHForwardHandler(st, sshForwarder)
```

Register the rule-CRUD routes inside the existing `!isRuntime` SSH block, after the file routes:

```go
		mux.HandleFunc("GET /api/ssh/connections/{id}/forwards", sshForwardH.GetForConnection)
		mux.HandleFunc("POST /api/ssh/connections/{id}/forwards", sshForwardH.Post)
		mux.HandleFunc("PATCH /api/ssh/forwards/{id}", sshForwardH.Patch)
		mux.HandleFunc("DELETE /api/ssh/forwards/{id}", sshForwardH.Delete)
```

Register the lifecycle routes **outside** that block, with the other all-role routes, since the executor is usually a runtime:

```go
	// Every role: the executor holds the live listener.
	mux.HandleFunc("POST /api/ssh/forwards/start", sshForwardH.PostStart)
	mux.HandleFunc("POST /api/ssh/forwards/{id}/stop", sshForwardH.PostStop)
	mux.HandleFunc("GET /api/ssh/forwards/states", sshForwardH.GetStates)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/handler/ -run Forward -v && go build ./... && go vet ./...`
Expected: 5 tests PASS, build and vet clean.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handler/sshforward.go backend/internal/handler/sshforward_test.go \
        backend/cmd/server/main.go
git commit -m "feat(ssh): add forwarding rule CRUD and lifecycle routes"
```

---

### Task 7: Frontend data layer and forwards panel

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/features/data/keys.ts`
- Modify: `frontend/src/features/data/queries.ts`
- Create: `frontend/src/features/ssh/SSHForwardsPanel.tsx`
- Test: `frontend/src/features/ssh/SSHForwardsPanel.test.tsx` (create)
- Modify: `frontend/src/features/ssh/SSHConnectionDialog.tsx`
- Modify: `frontend/vite.config.ts`

**Interfaces:**
- Consumes: `SSHForward`, `SSHForwardState`, `SSHForwardMode`, `SSHForwardStatus` (Task 1); routes (Task 6).
- Produces: `fetchSSHForwards`, `createSSHForward`, `updateSSHForward`, `deleteSSHForward`, `startSSHForward`, `stopSSHForward`, `fetchSSHForwardStates`; `useSSHForwards`, `useSSHForwardStates`, and mutation hooks; `<SSHForwardsPanel connectionId={string} />`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/ssh/SSHForwardsPanel.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SSHForward, SSHForwardState } from '@/store/types'

const mockUseSSHForwards = vi.fn()
const mockUseSSHForwardStates = vi.fn()
const mockStart = vi.fn()
const mockStop = vi.fn()

vi.mock('@/features/data/queries', () => ({
  useSSHForwards: (id: string) => mockUseSSHForwards(id),
  useSSHForwardStates: () => mockUseSSHForwardStates(),
  useCreateSSHForward: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSSHForward: () => ({ mutate: vi.fn(), isPending: false }),
  useStartSSHForward: () => ({ mutate: mockStart, isPending: false }),
  useStopSSHForward: () => ({ mutate: mockStop, isPending: false }),
}))

const { SSHForwardsPanel } = await import('./SSHForwardsPanel')

const localRule: SSHForward = {
  id: 'f1',
  connectionId: 'c1',
  mode: 'local',
  bindHost: '127.0.0.1',
  bindPort: 5432,
  targetHost: 'db.internal',
  targetPort: 5432,
  label: '',
}

function state(over: Partial<SSHForwardState> = {}): SSHForwardState {
  return { forwardId: 'f1', status: 'off', attempts: 0, ...over }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SSHForwardsPanel', () => {
  it('renders a loading state', () => {
    mockUseSSHForwards.mockReturnValue({ data: undefined, isLoading: true, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [] })

    render(<SSHForwardsPanel connectionId="c1" />)

    expect(screen.getByText(/loading/i)).toBeTruthy()
  })

  it('renders an empty state when there are no rules', () => {
    mockUseSSHForwards.mockReturnValue({ data: [], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [] })

    render(<SSHForwardsPanel connectionId="c1" />)

    expect(screen.getByText(/no forwarding rules/i)).toBeTruthy()
  })

  it('renders an error state', () => {
    mockUseSSHForwards.mockReturnValue({ data: undefined, isLoading: false, error: new Error('nope') })
    mockUseSSHForwardStates.mockReturnValue({ data: [] })

    render(<SSHForwardsPanel connectionId="c1" />)

    expect(screen.getByText(/nope/i)).toBeTruthy()
  })

  it('shows the rule with its bind and target', () => {
    mockUseSSHForwards.mockReturnValue({ data: [localRule], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [state()] })

    render(<SSHForwardsPanel connectionId="c1" />)

    expect(screen.getByText(/127\.0\.0\.1:5432/)).toBeTruthy()
    expect(screen.getByText(/db\.internal:5432/)).toBeTruthy()
  })

  it('toggling an off rule starts it with the full rule body', () => {
    mockUseSSHForwards.mockReturnValue({ data: [localRule], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [state()] })

    render(<SSHForwardsPanel connectionId="c1" />)
    screen.getByRole('switch', { name: /toggle forward/i }).click()

    expect(mockStart).toHaveBeenCalledWith(localRule)
  })

  it('toggling a running rule stops it by id', () => {
    mockUseSSHForwards.mockReturnValue({ data: [localRule], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [state({ status: 'running', boundAddr: '127.0.0.1:5432' })] })

    render(<SSHForwardsPanel connectionId="c1" />)
    screen.getByRole('switch', { name: /toggle forward/i }).click()

    expect(mockStop).toHaveBeenCalledWith('f1')
  })

  it('surfaces a failed rule error', () => {
    mockUseSSHForwards.mockReturnValue({ data: [localRule], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({
      data: [state({ status: 'failed', error: 'port 5432 unavailable' })],
    })

    render(<SSHForwardsPanel connectionId="c1" />)

    expect(screen.getByText(/port 5432 unavailable/)).toBeTruthy()
  })

  it('warns when a rule binds a non-loopback address', () => {
    mockUseSSHForwards.mockReturnValue({
      data: [{ ...localRule, bindHost: '0.0.0.0' }],
      isLoading: false,
      error: null,
    })
    mockUseSSHForwardStates.mockReturnValue({ data: [state()] })

    render(<SSHForwardsPanel connectionId="c1" />)

    expect(screen.getByText(/reachable by anything/i)).toBeTruthy()
  })

  it('adds the GatewayPorts note for a non-loopback remote forward', () => {
    mockUseSSHForwards.mockReturnValue({
      data: [{ ...localRule, mode: 'remote' as const, bindHost: '0.0.0.0' }],
      isLoading: false,
      error: null,
    })
    mockUseSSHForwardStates.mockReturnValue({ data: [state()] })

    render(<SSHForwardsPanel connectionId="c1" />)

    expect(screen.getByText(/GatewayPorts/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Register the test file**

In `frontend/vite.config.ts` `test.include`:

```ts
      'src/features/ssh/SSHForwardsPanel.test.tsx',
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ssh/SSHForwardsPanel.test.tsx`
Expected: FAIL — cannot resolve `./SSHForwardsPanel`.

- [ ] **Step 4: Add the API functions and hooks**

In `frontend/src/lib/api.ts`, following the shape of the neighbouring SSH functions:

```ts
export function fetchSSHForwards(connectionId: string): Promise<SSHForward[]> {
  return request<SSHForward[]>('GET', `/api/ssh/connections/${connectionId}/forwards`)
}

export function createSSHForward(connectionId: string, body: Omit<SSHForward, 'id' | 'connectionId'>): Promise<SSHForward> {
  return request<SSHForward>('POST', `/api/ssh/connections/${connectionId}/forwards`, body)
}

export function updateSSHForward(id: string, body: Partial<Omit<SSHForward, 'id' | 'connectionId'>>): Promise<SSHForward> {
  return request<SSHForward>('PATCH', `/api/ssh/forwards/${id}`, body)
}

export function deleteSSHForward(id: string): Promise<void> {
  return request<void>('DELETE', `/api/ssh/forwards/${id}`)
}

/** Starts a forward by pushing the whole rule: the executor holds no
 *  persisted copy of it, which is what keeps forwards out of catalog sync. */
export function startSSHForward(rule: SSHForward): Promise<SSHForwardState> {
  return request<SSHForwardState>('POST', '/api/ssh/forwards/start', rule)
}

export function stopSSHForward(id: string): Promise<SSHForwardState> {
  return request<SSHForwardState>('POST', `/api/ssh/forwards/${id}/stop`)
}

export function fetchSSHForwardStates(): Promise<SSHForwardState[]> {
  return request<SSHForwardState[]>('GET', '/api/ssh/forwards/states')
}
```

In `keys.ts`:

```ts
  sshForwards: (connectionId: string) => ['ssh', connectionId, 'forwards'] as const,
  sshForwardStates: ['ssh', 'forwardStates'] as const,
```

In `queries.ts`, add `useSSHForwards(connectionId)`, `useSSHForwardStates(enabled)` (with `refetchInterval: 2000`), and `useCreateSSHForward`, `useUpdateSSHForward`, `useDeleteSSHForward`, `useStartSSHForward`, `useStopSSHForward`. Every mutation invalidates `qk.sshForwards(connectionId)` and `qk.sshForwardStates` on success, and toasts + invalidates on error, per the standing convention.

- [ ] **Step 5: Write the panel**

Create `frontend/src/features/ssh/SSHForwardsPanel.tsx`. Requirements:

- A row per rule: mode badge (`-L` / `-R` / `-D`), `bindHost:bindPort`, an arrow (`→` for local/dynamic, `←` for remote), `targetHost:targetPort` (or `(dynamic SOCKS5)`), a status dot, a toggle switch labelled "Toggle forward", and delete.
- Status dot colors: `running` green (`--devdeck-green-soft` or the token used elsewhere for healthy), `reconnecting` yellow, `failed` red, `off`/`starting` grey. Read `src/styles/globals.css` and use existing tokens; do not invent hexes.
- A `failed` row shows its `error` text.
- A rule whose `bindHost` is not `127.0.0.1`/`localhost` shows: "Reachable by anything that can route to the executor."
- A `remote` rule with a non-loopback bind additionally shows: "Requires `GatewayPorts yes` on the remote sshd."
- An add-rule row with mode, bind host/port, target host/port. Target inputs are disabled for `dynamic`.
- Explicit loading, error, and empty states — the empty state reads "No forwarding rules yet."

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/ssh/SSHForwardsPanel.test.tsx && npm run typecheck`
Expected: 9 tests PASS, typecheck clean.

- [ ] **Step 7: Mount it in the connection dialog**

Add `<SSHForwardsPanel connectionId={connection.id} />` to `SSHConnectionDialog.tsx`, shown only when editing an existing connection — a rule needs a connection id, which a not-yet-created connection does not have.

- [ ] **Step 8: Full verification**

Run:
```bash
cd frontend && npm run typecheck && npx vitest run
cd ../backend && go vet ./... && go test ./internal/...
```
Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/features/data/keys.ts \
        frontend/src/features/data/queries.ts \
        frontend/src/features/ssh/SSHForwardsPanel.tsx \
        frontend/src/features/ssh/SSHForwardsPanel.test.tsx \
        frontend/src/features/ssh/SSHConnectionDialog.tsx \
        frontend/vite.config.ts
git commit -m "feat(ssh): add port-forwarding rules panel"
```

---

## Manual verification

Against a real Linux SSH host:

1. Open an SSH connection's dialog. The Forwards panel is empty.
2. Add a `-L` rule: bind `127.0.0.1:15432`, target a service reachable only from that host. Toggle it on; the dot goes green.
3. Connect to `127.0.0.1:15432` locally and confirm you reach the remote service.
4. Add a `-D` rule on `127.0.0.1:1081`, toggle on, then:
   ```bash
   curl -x socks5h://127.0.0.1:1081 https://example.com -o /dev/null -w '%{http_code}\n'
   ```
   Expected `200`, resolved from the remote host's network.
5. Add a `-R` rule and confirm the remote side reaches back to a local service.
6. Break the network (disable Wi-Fi for ~10s). The rule goes `reconnecting`, then returns to `running` on its own.
7. Toggle a rule off and confirm the local port refuses connections.
8. Enter a wrong target on a new rule and confirm it goes `failed` with a message, and does **not** sit retrying.
9. Restart the server. Every forward comes back `off` — no autostart, by design.
10. Delete the SSH connection and confirm its rules are gone (FK cascade).
