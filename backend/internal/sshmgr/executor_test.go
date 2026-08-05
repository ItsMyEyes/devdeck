package sshmgr

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"testing"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/netproxy"
)

type fakeMachines map[string]domain.Machine

func (f fakeMachines) MachineByID(id string) (domain.Machine, error) {
	m, ok := f[id]
	if !ok {
		return domain.Machine{}, errors.New("machine not found")
	}
	return m, nil
}

// countingProxy hands out a real SOCKS5 listener's address and records how
// many times routing asked for one, so a test can assert both that the dial
// went through the proxy and that a direct dial never consulted it.
type countingProxy struct {
	addr  string
	calls atomic.Int32
	err   error
}

func (p *countingProxy) StartSOCKS(_ context.Context, _ domain.Machine) (string, error) {
	p.calls.Add(1)
	if p.err != nil {
		return "", p.err
	}
	return p.addr, nil
}

// startTestSOCKS5 runs the same unauthenticated SOCKS5 server a runtime's
// ProxyService starts, and reports how many connections it relayed — the
// evidence that a dial really traversed the executor rather than going direct.
func startTestSOCKS5(t *testing.T) (addr string, relayed *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })

	var count atomic.Int32
	counted := &countingListener{Listener: ln, count: &count}
	go func() { _ = netproxy.NewSOCKS5Server("").Serve(counted) }()
	return ln.Addr().String(), &count
}

type countingListener struct {
	net.Listener
	count *atomic.Int32
}

func (l *countingListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err == nil {
		l.count.Add(1)
	}
	return conn, err
}

func TestDialRoutesThroughExecutorMachine(t *testing.T) {
	sshAddr, _ := startTestSSHServer(t, nil)
	socksAddr, relayed := startTestSOCKS5(t)

	conn := testConn(t, sshAddr)
	conn.ExecutorMachineID = strPtr("m-runtime")
	proxies := &countingProxy{addr: socksAddr}
	d := NewDialer(&fakeConnStore{conn: conn}, fakeSecrets{"password": "secret"}).
		WithExecutorRouting(
			fakeMachines{"m-runtime": {ID: "m-runtime", Name: "builder", URL: "https://builder.example"}},
			proxies,
		)

	client, err := d.Dial(context.Background(), "sc-test")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	client.Close()

	if got := relayed.Load(); got != 1 {
		t.Errorf("connections through executor SOCKS5 = %d, want 1", got)
	}
	if got := proxies.calls.Load(); got != 1 {
		t.Errorf("StartSOCKS calls = %d, want 1", got)
	}
}

func TestDialWithoutExecutorDialsDirectly(t *testing.T) {
	sshAddr, _ := startTestSSHServer(t, nil)
	socksAddr, relayed := startTestSOCKS5(t)

	proxies := &countingProxy{addr: socksAddr}
	d := NewDialer(&fakeConnStore{conn: testConn(t, sshAddr)}, fakeSecrets{"password": "secret"}).
		WithExecutorRouting(fakeMachines{}, proxies)

	client, err := d.Dial(context.Background(), "sc-test")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	client.Close()

	if got := relayed.Load(); got != 0 {
		t.Errorf("connections through SOCKS5 = %d, want 0 (no executor set)", got)
	}
	if got := proxies.calls.Load(); got != 0 {
		t.Errorf("StartSOCKS calls = %d, want 0", got)
	}
}

// A machine flagged IsLocal is this very process's own embedded runtime, so
// proxying through it would add a hop that changes nothing about which
// network the dial leaves from.
func TestDialWithLocalExecutorDialsDirectly(t *testing.T) {
	sshAddr, _ := startTestSSHServer(t, nil)
	socksAddr, relayed := startTestSOCKS5(t)

	conn := testConn(t, sshAddr)
	conn.ExecutorMachineID = strPtr("m-local")
	proxies := &countingProxy{addr: socksAddr}
	d := NewDialer(&fakeConnStore{conn: conn}, fakeSecrets{"password": "secret"}).
		WithExecutorRouting(
			fakeMachines{"m-local": {ID: "m-local", Name: "this mac", IsLocal: true}},
			proxies,
		)

	client, err := d.Dial(context.Background(), "sc-test")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	client.Close()

	if got := relayed.Load(); got != 0 {
		t.Errorf("connections through SOCKS5 = %d, want 0 (local executor)", got)
	}
	if got := proxies.calls.Load(); got != 0 {
		t.Errorf("StartSOCKS calls = %d, want 0", got)
	}
}

// An unreachable executor must fail loudly rather than silently dialing from
// the hub: the operator picked that executor precisely because the hub is the
// wrong origin for this host.
func TestDialFailsWhenExecutorProxyUnavailable(t *testing.T) {
	sshAddr, _ := startTestSSHServer(t, nil)

	conn := testConn(t, sshAddr)
	conn.ExecutorMachineID = strPtr("m-runtime")
	d := NewDialer(&fakeConnStore{conn: conn}, fakeSecrets{"password": "secret"}).
		WithExecutorRouting(
			fakeMachines{"m-runtime": {ID: "m-runtime", Name: "builder"}},
			&countingProxy{err: errors.New("machine unreachable")},
		)

	_, err := d.Dial(context.Background(), "sc-test")
	if err == nil {
		t.Fatal("Dial succeeded with an unreachable executor, want error")
	}
	if !strings.Contains(err.Error(), "builder") {
		t.Errorf("err = %q, want it to name the executor machine", err)
	}
}

func TestDialFailsWhenExecutorMachineUnknown(t *testing.T) {
	sshAddr, _ := startTestSSHServer(t, nil)

	conn := testConn(t, sshAddr)
	conn.ExecutorMachineID = strPtr("m-gone")
	d := NewDialer(&fakeConnStore{conn: conn}, fakeSecrets{"password": "secret"}).
		WithExecutorRouting(fakeMachines{}, &countingProxy{})

	if _, err := d.Dial(context.Background(), "sc-test"); err == nil {
		t.Fatal("Dial succeeded with an unknown executor machine, want error")
	}
}

// A dialer built without WithExecutorRouting (a --role runtime backend, and
// every pre-existing caller) must keep dialing locally even for a connection
// that names an executor, rather than erroring on the missing wiring.
func TestDialWithoutRoutingWiredIgnoresExecutor(t *testing.T) {
	sshAddr, _ := startTestSSHServer(t, nil)

	conn := testConn(t, sshAddr)
	conn.ExecutorMachineID = strPtr("m-runtime")
	d := NewDialer(&fakeConnStore{conn: conn}, fakeSecrets{"password": "secret"})

	client, err := d.Dial(context.Background(), "sc-test")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	client.Close()
}
