package sshmgr

import (
	"context"
	"fmt"
	"net"

	"golang.org/x/net/proxy"

	"devdeck/backend/internal/domain"
)

// MachineSource resolves a connection's ExecutorMachineID into the registered
// runtime that should dial it. Implemented by store.Store (MachineByID).
//
// Kept as its own narrow interface, like ConnStore above it, so the dialer
// depends on the two store methods it actually calls rather than the whole
// port.Store — and so tests can route a dial at a fake machine without
// standing up a registry.
type MachineSource interface {
	MachineByID(id string) (domain.Machine, error)
}

// ProxyStarter starts (idempotently) a machine's forward proxy and returns
// the tailnet-reachable address of its SOCKS5 listener. Implemented by
// machineclient.StartSOCKSProxy; an interface here so dialing through a
// machine is testable without a live runtime.
type ProxyStarter interface {
	StartSOCKS(ctx context.Context, m domain.Machine) (string, error)
}

// netDialer is the subset of net.Dialer / proxy.ContextDialer that dial uses
// to open the underlying TCP connection to an SSH host. The hub-local path
// supplies a plain *net.Dialer; the executor-routed path supplies a SOCKS5
// dialer pointed at the executor runtime.
type netDialer interface {
	DialContext(ctx context.Context, network, addr string) (net.Conn, error)
}

// executorDialer returns the netDialer that conn's TCP connection must be
// opened with.
//
// This is the whole of "ExecutorMachineID routing": everything downstream —
// the SSH handshake, the interactive shell, and every SFTP file operation,
// since they all share one *ssh.Client from Dial — inherits the executor
// simply by virtue of the TCP connection having been opened from there.
//
// Routing rides the executor's existing SOCKS5 forward proxy
// (service.ProxyService, already used by FaviconService to fetch through a
// machine that can resolve a host the hub cannot). Credentials are NOT
// forwarded: the hub keeps decrypting them and completes the SSH handshake
// itself, end-to-end over the tunnelled TCP stream. The runtime only ever
// relays bytes, so it never sees a password, a private key, or the plaintext
// session — a strictly smaller trust surface than the database path's
// descriptor forwarding, which does hand credentials to the runtime.
//
// A nil/empty ExecutorMachineID, or one naming a machine flagged IsLocal
// (the desktop's own embedded runtime, i.e. this very process), dials
// directly — routing a connection through a proxy running inside the same
// process would add a hop that changes nothing about which network the dial
// originates from.
func (d *Dialer) executorDialer(ctx context.Context, conn domain.SSHConnection) (netDialer, error) {
	direct := &net.Dialer{Timeout: dialTimeout}
	if conn.ExecutorMachineID == nil || *conn.ExecutorMachineID == "" {
		return direct, nil
	}
	if d.machines == nil || d.proxies == nil {
		return direct, nil
	}

	m, err := d.machines.MachineByID(*conn.ExecutorMachineID)
	if err != nil {
		return nil, fmt.Errorf("executor machine %s: %w", *conn.ExecutorMachineID, err)
	}
	if m.IsLocal {
		return direct, nil
	}

	socksAddr, err := d.proxies.StartSOCKS(ctx, m)
	if err != nil {
		// Deliberately not a silent fallback to a hub-local dial: the operator
		// picked this executor because the hub cannot reach the host (or must
		// not), so quietly dialing from the hub would either fail with a
		// confusing error or succeed from the wrong network.
		return nil, fmt.Errorf("start forward proxy on executor machine %s: %w", m.Name, err)
	}

	// proxy.SOCKS5 with a nil auth dials without RFC 1929 negotiation, matching
	// how service.ProxyService starts the listener (NewSOCKS5Server("")).
	socks, err := proxy.SOCKS5("tcp", socksAddr, nil, direct)
	if err != nil {
		return nil, fmt.Errorf("dial forward proxy on executor machine %s: %w", m.Name, err)
	}
	ctxDialer, ok := socks.(proxy.ContextDialer)
	if !ok {
		return nil, fmt.Errorf("socks5 dialer for executor machine %s does not support contexts", m.Name)
	}
	return ctxDialer, nil
}
