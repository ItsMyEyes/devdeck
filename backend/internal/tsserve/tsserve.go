// Package tsserve owns this process's `tailscale serve` child, so exposure on
// the tailnet can be switched on and off while the hub is running instead of
// only at launch.
//
// It was a launch-only decision before: main.go read --enable-tailscale-serve
// once and that was that. The desktop shell derives that flag from a one-shot
// preflight at spawn time, which loses a race against a Tailscale daemon that
// has not finished coming up at login — leaving a hub that can never expose
// itself no matter how many times it is restarted, because every restart runs
// the same losing probe. A runtime switch is the escape hatch from that.
package tsserve

import (
	"bytes"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// startGrace is how long Start waits to see whether the serve child survives.
//
// `tailscale serve` reports its real failures by exiting a moment AFTER a
// perfectly successful fork — most importantly "listener already exists for
// port 443", which is what a second DevDeck on the same machine hits. Without
// this wait, Start returned success for a child that was already dead and the
// UI toggle flipped on and then silently sprang back on the next poll, with
// tailscale's own explanation visible nowhere.
const startGrace = 700 * time.Millisecond

// syncBuffer collects the child's output. Guarded because os/exec's copier
// writes it from another goroutine.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

// firstLine is tailscale's own error message, stripped of its log timestamp
// so it reads as a sentence in the UI rather than a log excerpt.
func (b *syncBuffer) firstLine() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, line := range strings.Split(b.buf.String(), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Drop a leading "2026/08/28 14:20:04 " stamp if present.
		if parts := strings.SplitN(line, " ", 3); len(parts) == 3 &&
			strings.Count(parts[0], "/") == 2 && strings.Count(parts[1], ":") == 2 {
			return parts[2]
		}
		return line
	}
	return ""
}

// Controller owns at most one `tailscale serve` child at a time.
//
// The child runs in the FOREGROUND (no --bg) on purpose: tailscaled keeps the
// serve config only while that process lives, so stopping is just killing it
// and a crashed hub cannot strand a mapping. That is also why Stop needs no
// tailscale call of its own.
type Controller struct {
	// gate serializes whole Start/Stop operations, so a Start's grace wait
	// cannot interleave with another transition. mu guards only the fields
	// below, and is never held across a wait — the reaper goroutine needs it.
	gate sync.Mutex

	mu   sync.Mutex
	cmd  *exec.Cmd
	port string
	// resolve finds the tailscale CLI. Injected so tests can point at a fake
	// rather than depending on what is installed on the machine running them.
	resolve func() (string, error)
	// grace is startGrace, overridable so tests need not sleep for real.
	grace time.Duration
}

func New(resolve func() (string, error)) *Controller {
	return &Controller{resolve: resolve, grace: startGrace}
}

// Status reports whether a serve child is running and which port it fronts.
func (c *Controller) Status() (running bool, port string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cmd != nil, c.port
}

// Start fronts `port` on the tailnet, replacing any serve this Controller
// already started. Returns an error rather than exiting: a hub that cannot
// expose itself must still serve locally.
func (c *Controller) Start(port string) error {
	if port == "" {
		return fmt.Errorf("no port to serve")
	}
	bin, err := c.resolve()
	if err != nil {
		return fmt.Errorf("tailscale CLI not found in PATH or common install locations")
	}

	c.gate.Lock()
	defer c.gate.Unlock()

	c.mu.Lock()
	if c.cmd != nil {
		if c.port == port {
			c.mu.Unlock()
			return nil // already serving exactly this — idempotent
		}
		c.stopLocked()
	}
	c.mu.Unlock()

	// Best-effort and deliberately not fatal: "there was nothing to remove" is
	// the normal, healthy case and reports itself as a non-zero exit here. See
	// clearArgs for why a stale mapping has to be cleared at all.
	if err := exec.Command(bin, clearArgs()...).Run(); err != nil {
		log.Printf("tailscale: no existing 443 listener to clear (%v)", err)
	}

	cmd := exec.Command(bin, "serve", port)
	out := &syncBuffer{}
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start tailscale serve: %w", err)
	}

	exited := make(chan struct{})
	go func() {
		err := cmd.Wait()
		close(exited)
		c.mu.Lock()
		defer c.mu.Unlock()
		// Only clear if this is still the current child: a Start that replaced
		// it has already moved c.cmd on, and clearing here would wrongly
		// report the NEW serve as stopped.
		if c.cmd == cmd {
			c.cmd = nil
			c.port = ""
		}
		if err != nil {
			log.Printf("tailscale serve exited: %v (devdeck keeps serving locally)", err)
			return
		}
		log.Printf("tailscale serve exited")
	}()

	// A fork that succeeds proves nothing — see startGrace.
	select {
	case <-exited:
		if msg := out.firstLine(); msg != "" {
			return fmt.Errorf("tailscale serve: %s", msg)
		}
		return fmt.Errorf("tailscale serve exited immediately")
	case <-time.After(c.grace):
	}

	c.mu.Lock()
	c.cmd = cmd
	c.port = port
	c.mu.Unlock()
	log.Printf("tailscale: serving port %s on your tailnet (pid %d)", port, cmd.Process.Pid)
	return nil
}

// Stop kills the serve child, dropping the tailnet mapping with it. A no-op
// when nothing is running, so callers need not check first.
func (c *Controller) Stop() error {
	c.gate.Lock()
	defer c.gate.Unlock()
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stopLocked()
}

// stopLocked is Stop's body; callers must hold c.mu.
func (c *Controller) stopLocked() error {
	if c.cmd == nil {
		return nil
	}
	cmd := c.cmd
	// Cleared before the kill so Status reports "stopped" immediately rather
	// than during the gap before the Wait goroutine notices.
	c.cmd = nil
	c.port = ""
	if cmd.Process == nil {
		return nil
	}
	if err := cmd.Process.Kill(); err != nil {
		return fmt.Errorf("stop tailscale serve: %w", err)
	}
	return nil
}

// clearArgs removes any existing HTTPS listener on 443 before this process
// claims it.
//
// It exists because `tailscale serve <port>` REFUSES to replace a listener
// rather than overwriting it — it exits 1 with "sending serve config:
// updating config: listener already exists for port 443". A single leftover
// mapping (an older build's `--bg`, or a run that was killed before its
// foreground child could clean up) therefore breaks serve permanently: not
// just once, but on every attempt from then on.
//
// The failure mode that causes is genuinely misleading, because this hub may
// bind an OS-ASSIGNED port (the desktop shell asks for 8989 but falls back to
// an ephemeral port when something already holds it — see
// frontend/src-tauri/src/sidecar.rs's listen_addr). The stale mapping keeps
// pointing at whatever port a previous run happened to get, so the tailnet URL
// answers 502 while the process itself is perfectly healthy and still serving
// on loopback — and anything that reaches this hub only over the tailnet (a
// remote runtime's self-registration and catalog sync) fails with no symptom
// on this side at all.
//
// Scoped to `--https=443 off`, never `serve reset`: reset drops the whole
// machine's serve configuration — other ports, TCP forwarders, funnel — none
// of which belongs to devdeck. 443's `/` is the one mapping this owns, and it
// owns it exclusively.
func clearArgs() []string { return []string{"serve", "--https=443", "off"} }
