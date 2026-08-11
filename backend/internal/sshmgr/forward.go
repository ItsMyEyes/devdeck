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

// activeForward is one supervisor run. The pointer itself is that run's
// identity: Start mints a fresh one per call, so comparing f.active[id] to
// this pointer answers "am I still the current supervisor for this id?" —
// which an id lookup alone cannot, since a stop-then-restart reuses the id.
type activeForward struct {
	rule   domain.SSHForward
	state  domain.SSHForwardState
	client *ssh.Client
	ln     net.Listener
	cancel context.CancelFunc
	// done closes when this run's supervise goroutine has fully exited,
	// including the "superseded, bailing out" path. Stop waits on it so a
	// stop-then-restart (handler.Patch's edit path) can never leave the
	// previous supervisor still mid-runOnce, about to bind the very port the
	// next one is about to bind.
	done chan struct{}
}

// errSupervisorSuperseded means this run's entry is no longer the current one
// for its id — Stop removed it, or a later Start replaced it. Whatever the
// run had just built is already closed; there is nothing to report and
// nothing to retry, so supervise exits on it immediately rather than sleeping
// out a backoff nobody is waiting for.
var errSupervisorSuperseded = errors.New("forward supervisor superseded")

func NewForwarder(dialer *Dialer) *Forwarder {
	return &Forwarder{dialer: dialer, active: map[string]*activeForward{}}
}

// Start validates the rule and launches its supervisor. Starting an id that
// is already active stops the old one first, so editing a running rule never
// leaves two listeners fighting over a port. That stop is synchronous: the
// previous supervisor has fully exited before the new one is launched, so it
// cannot still be mid-dial and about to bind the port this run wants.
func (f *Forwarder) Start(rule domain.SSHForward) (domain.SSHForwardState, error) {
	if err := validateForward(rule); err != nil {
		return domain.SSHForwardState{}, err
	}
	_ = f.Stop(rule.ID)

	ctx, cancel := context.WithCancel(context.Background())
	entry := &activeForward{
		rule:   rule,
		cancel: cancel,
		done:   make(chan struct{}),
		state:  domain.SSHForwardState{ForwardID: rule.ID, Status: "starting"},
	}

	f.mu.Lock()
	f.active[rule.ID] = entry
	// Capture the state to return WHILE still holding the lock — supervise
	// (launched below) mutates entry.state under this same lock from
	// another goroutine, and reading entry.state after Unlock would race it.
	initial := entry.state
	f.mu.Unlock()

	go f.supervise(ctx, entry)
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
	// Wait — with the mutex released — for the supervisor to actually exit,
	// which is what makes Stop synchronous. Without it, Stop can return while
	// the supervisor is still inside runOnce with nothing bound yet (ln was
	// nil above, so the close was a no-op); it would then bind the port the
	// caller's very next Start is about to bind, and the new supervisor would
	// fail terminally on a spurious "address already in use". Bounded by the
	// dial: cancel aborts the ctx-aware TCP connect, and the handshake past
	// it carries ssh.ClientConfig.Timeout.
	<-entry.done
	return nil
}

// StopAll tears down every currently active forward, for a graceful-shutdown
// path that must not leave forwarded listeners (or their SSH transports)
// running past the server exiting. Ids are snapshotted under f.mu, then
// stopped CONCURRENTLY — Stop blocks on entry.done until its supervisor
// goroutine fully exits, so stopping many forwards one at a time would sum
// each one's teardown latency instead of paying it once in parallel, the
// same reasoning as registry.killAll on the terminal side.
func (f *Forwarder) StopAll() {
	f.mu.Lock()
	ids := make([]string, 0, len(f.active))
	for id := range f.active {
		ids = append(ids, id)
	}
	f.mu.Unlock()

	var wg sync.WaitGroup
	wg.Add(len(ids))
	for _, id := range ids {
		go func(id string) {
			defer wg.Done()
			_ = f.Stop(id)
		}(id)
	}
	wg.Wait()
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

// setState mutates one run's own state, and only while that run is still the
// current one for its id. Taking the entry rather than the id is the point: a
// superseded supervisor must not write its verdict into the newer run that
// has since taken over the id — which is how a stale "address already in use"
// used to land on a rule that was in fact starting cleanly.
func (f *Forwarder) setState(entry *activeForward, mutate func(*domain.SSHForwardState)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.active[entry.rule.ID] == entry {
		mutate(&entry.state)
	}
}

// supervise runs one forward's whole lifetime: dial, bind, serve, and — when
// the transport dies — back off and do it again. It exits only on Stop
// (ctx cancelled), a terminal error, or being superseded by a later Start.
func (f *Forwarder) supervise(ctx context.Context, entry *activeForward) {
	defer close(entry.done) // Stop blocks on this; every exit path must reach it
	attempt := 0
	for {
		if ctx.Err() != nil {
			return
		}

		dead, err := f.runOnce(ctx, entry)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, errSupervisorSuperseded) {
				return // Stop raced us; not a failure worth reporting
			}
			if isTerminalForwardErr(err) {
				// A revoked key or a taken port will never fix itself.
				// Retrying would hide a dead rule behind a hopeful
				// "reconnecting" forever.
				f.setState(entry, func(s *domain.SSHForwardState) {
					s.Status = "failed"
					s.Error = err.Error()
					s.Attempts = attempt
				})
				return
			}
			f.setState(entry, func(s *domain.SSHForwardState) {
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
			f.setState(entry, func(s *domain.SSHForwardState) {
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
func (f *Forwarder) runOnce(ctx context.Context, entry *activeForward) (<-chan struct{}, error) {
	rule := entry.rule
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
	// Identity, not id: Stop may have removed this entry, or a later Start
	// replaced it with a fresh one, while we were dialing and binding.
	// Publishing our listener into whatever entry now holds this id would
	// hand the NEXT supervisor a listener it never opened while leaving our
	// own port bound — so its net.Listen fails with a spurious "address
	// already in use", which isTerminalForwardErr then correctly (but
	// uselessly) treats as permanent, wedging a healthy rule at "failed".
	if f.active[rule.ID] != entry {
		// Stopped or superseded while we were dialing — drop what we just
		// built rather than leaking a listener nothing will ever close.
		f.mu.Unlock()
		_ = ln.Close()
		_ = client.Close()
		return nil, errSupervisorSuperseded
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
	// "not found" is the deleted-saved-connection case (store.ErrNotFound is
	// literally "not found"). It deliberately does NOT list "no such": that
	// was meant for the same case, but it is redundant there and matches Go's
	// DNS error "no such host" too — stranding a running forward at "failed"
	// the first time its host stops resolving over a sleep or a VPN switch,
	// which is precisely the blip the reconnect loop exists to ride out.
	for _, terminal := range []string{
		"unable to authenticate", "no stored password", "no stored private key",
		"parse private key", "unsupported auth type", "address already in use",
		"not found",
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
	case "remote":
		return client.Listen("tcp", net.JoinHostPort(rule.BindHost, strconv.Itoa(rule.BindPort)))
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

// serve runs the accept loop for modes that need one of their own. "local"
// dials the target through the SSH client per accepted connection; "remote"
// dials the target locally (the SSH client already delivered the connection
// from the far end). Both close both ends when the proxied copy finishes
// (netproxy.Relay only half-closes; its callers own Close()). "dynamic"
// already has its own accept loop running inside the SOCKS5Server that
// listenFor started, so this returns immediately for it.
func (f *Forwarder) serve(rule domain.SSHForward, client *ssh.Client, ln net.Listener) {
	switch rule.Mode {
	case "local":
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
	case "remote":
		for {
			accepted, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				local, err := net.DialTimeout("tcp", net.JoinHostPort(rule.TargetHost, strconv.Itoa(rule.TargetPort)), 10*time.Second)
				if err != nil {
					_ = accepted.Close()
					return
				}
				netproxy.Relay(accepted, local)
				_ = accepted.Close()
				_ = local.Close()
			}()
		}
	default:
		// "dynamic": its accept loop already runs inside the SOCKS5Server
		// that listenFor started — a second loop here would race it.
		return
	}
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
