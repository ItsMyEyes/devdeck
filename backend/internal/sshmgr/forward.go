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
	// Capture the state to return WHILE still holding the lock — supervise
	// (launched below) mutates entry.state under this same lock from
	// another goroutine, and reading entry.state after Unlock would race it.
	initial := entry.state
	f.mu.Unlock()

	go f.supervise(ctx, rule)
	return initial, nil
}

// Stop tears a forward down without touching the saved rule. Idempotent: an
// unknown or already-stopped id is a success, so a double-click or a stale
// UI cannot produce an error the operator has to think about.
func (f *Forwarder) Stop(forwardID string) error {
	f.mu.Lock()
	entry, ok := f.active[forwardID]
	// Capture ln/client into locals WHILE still holding the lock — runOnce
	// writes these same fields under this lock from another goroutine, and
	// reading entry.ln/entry.client after Unlock would race it.
	var ln net.Listener
	var client *ssh.Client
	if ok {
		delete(f.active, forwardID)
		ln = entry.ln
		client = entry.client
	}
	f.mu.Unlock()
	if !ok {
		return nil
	}
	entry.cancel()
	if ln != nil {
		_ = ln.Close()
	}
	if client != nil {
		_ = client.Close()
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

// backoffFor is the reconnect delay for a given attempt number: 1s, 2s, 4s,
// ... capped at 30s so a persistently down transport doesn't busy-loop, but
// a link that comes back quickly doesn't wait needlessly long either.
func backoffFor(attempt int) time.Duration {
	const maxBackoff = 30 * time.Second
	if attempt < 0 {
		attempt = 0
	}
	if attempt > 4 { // 1s<<5 == 32s already exceeds maxBackoff; avoid shifting further
		return maxBackoff
	}
	d := time.Second << uint(attempt)
	if d > maxBackoff {
		return maxBackoff
	}
	return d
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

// listenFor opens the mode-appropriate listener for a rule. For "dynamic"
// this also starts serving SOCKS5 immediately (SOCKS5Server owns its own
// accept loop), so `serve` below is a no-op for that mode — starting a
// second accept loop on the same listener would race the first one.
func (f *Forwarder) listenFor(rule domain.SSHForward, client *ssh.Client) (net.Listener, error) {
	switch rule.Mode {
	case "local":
		return net.Listen("tcp", net.JoinHostPort(rule.BindHost, strconv.Itoa(rule.BindPort)))
	case "dynamic":
		ln, err := net.Listen("tcp", net.JoinHostPort(rule.BindHost, strconv.Itoa(rule.BindPort)))
		if err != nil {
			return nil, err
		}
		srv := netproxy.NewSOCKS5Server("")
		srv.DialContext = func(_ context.Context, network, addr string) (net.Conn, error) {
			return client.Dial(network, addr)
		}
		go func() { _ = srv.Serve(ln) }()
		return ln, nil
	default:
		return nil, fmt.Errorf("unsupported forward mode %q", rule.Mode)
	}
}

// serve runs the accept loop for modes that need one of their own — "local"
// dials the target through the SSH client per accepted connection, closing
// both ends when the proxied copy finishes (netproxy.Relay only half-closes;
// its callers own Close()). "dynamic" already has its own accept loop
// running inside the SOCKS5Server that listenFor started, so this returns
// immediately for it.
func (f *Forwarder) serve(rule domain.SSHForward, client *ssh.Client, ln net.Listener) {
	if rule.Mode != "local" {
		return
	}
	for {
		accepted, err := ln.Accept()
		if err != nil {
			// ln.Close() — from Stop, or from runOnce's cleanup goroutine
			// when the transport dies — ends the loop this way. Expected,
			// not a failure to report anywhere.
			return
		}
		go func() {
			remote, err := client.Dial("tcp", net.JoinHostPort(rule.TargetHost, strconv.Itoa(rule.TargetPort)))
			if err != nil {
				// One dead target must not tear the forward down.
				_ = accepted.Close()
				return
			}
			netproxy.Relay(accepted, remote)
			_ = accepted.Close()
			_ = remote.Close()
		}()
	}
}
