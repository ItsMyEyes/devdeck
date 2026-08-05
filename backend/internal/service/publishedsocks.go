package service

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"sync"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/netproxy"
)

// defaultPublishedSOCKSPort is the conventional SOCKS5 port, used when a
// machine has never been configured.
const defaultPublishedSOCKSPort = 1080

// publishedSOCKSUser is the username half of the RFC 1929 credential. The
// SOCKS5 server accepts any username and checks only the password, but
// clients must send something, so the UI advertises a fixed one.
const publishedSOCKSUser = "devdeck"

// PublishedSOCKSStore is the narrow slice of port.Store this service needs,
// following the sshmgr.ConnStore precedent rather than taking the whole
// interface.
type PublishedSOCKSStore interface {
	PublishedSOCKS() (domain.PublishedSOCKSConfig, error)
	SetPublishedSOCKS(cfg domain.PublishedSOCKSConfig) error
}

// PublishedSOCKSService owns one long-lived, always-authenticated SOCKS5
// listener so other tools (a browser, curl, k9s) can route through this
// machine's network.
//
// Deliberately NOT an extension of ProxyService. That one binds ephemeral
// ports, dies with the process, and is unauthenticated by necessity — no
// platform's webview proxy_url can carry credentials (see ProxyService.Start).
// This one is operator-toggled, fixed-port, persisted, and refuses to bind
// without a key. The two coexist without interacting.
type PublishedSOCKSService struct {
	store PublishedSOCKSStore
	// advertiseHost is this machine's tailnet-reachable hostname. The
	// listener binds all interfaces, but the advertised URL must not be the
	// bind address: whoever dials this proxy is usually on another machine.
	advertiseHost string

	mu      sync.Mutex
	ln      net.Listener
	running domain.PublishedSOCKSConfig
}

func NewPublishedSOCKSService(store PublishedSOCKSStore, advertiseHost string) *PublishedSOCKSService {
	return &PublishedSOCKSService{store: store, advertiseHost: advertiseHost}
}

// generatePublishedSOCKSKey mints a 32-byte hex credential.
//
// setupui.GenerateKey does the same thing, but setupui is the interactive
// `devdeck setup` wizard; importing a CLI wizard into the service layer for a
// five-line helper is the wrong dependency direction, so this is local.
func generatePublishedSOCKSKey() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand.Read never fails on any supported platform; a failure
		// here means the system CSPRNG is broken and silently continuing
		// would mint a predictable proxy credential.
		panic("service: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(buf)
}

// Status reports stored intent plus what is actually bound right now.
func (s *PublishedSOCKSService) Status() (domain.PublishedSOCKSStatus, error) {
	cfg, err := s.store.PublishedSOCKS()
	if err != nil {
		return domain.PublishedSOCKSStatus{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked(cfg), nil
}

func (s *PublishedSOCKSService) statusLocked(cfg domain.PublishedSOCKSConfig) domain.PublishedSOCKSStatus {
	status := domain.PublishedSOCKSStatus{
		Enabled: cfg.Enabled,
		Port:    cfg.Port,
		Key:     cfg.Key,
		Running: s.ln != nil,
	}
	if s.ln != nil {
		status.BoundAddr = s.ln.Addr().String()
		hostPort := net.JoinHostPort(s.advertiseHost, strconv.Itoa(s.running.Port))
		status.URL = (&url.URL{
			Scheme: "socks5",
			User:   url.UserPassword(publishedSOCKSUser, s.running.Key),
			Host:   hostPort,
		}).String()
	}
	return status
}

// Apply is the single mutation point. It resolves the desired config, stops
// any listener whose port or key changed, binds the new one, and only then
// persists — so a failed bind never leaves the DB claiming a live listener.
//
// port <= 0 means "keep the stored port".
func (s *PublishedSOCKSService) Apply(enabled bool, port int, rotateKey bool) (domain.PublishedSOCKSStatus, error) {
	cfg, err := s.store.PublishedSOCKS()
	if err != nil {
		return domain.PublishedSOCKSStatus{}, err
	}
	if port > 0 {
		cfg.Port = port
	}
	if cfg.Port <= 0 {
		cfg.Port = defaultPublishedSOCKSPort
	}
	if cfg.Port > 65535 {
		return domain.PublishedSOCKSStatus{}, fmt.Errorf("port %d is out of range (1-65535)", cfg.Port)
	}
	// An empty stored key is treated as "rotate" rather than binding open:
	// there is no reachable path to an unauthenticated published listener.
	if rotateKey || cfg.Key == "" {
		cfg.Key = generatePublishedSOCKSKey()
	}
	cfg.Enabled = enabled

	s.mu.Lock()
	defer s.mu.Unlock()

	if !enabled {
		s.stopLocked()
		if err := s.store.SetPublishedSOCKS(cfg); err != nil {
			return domain.PublishedSOCKSStatus{}, err
		}
		return s.statusLocked(cfg), nil
	}

	if s.ln != nil && s.running == cfg {
		return s.statusLocked(cfg), nil // already serving exactly this
	}
	s.stopLocked()
	if err := s.bindLocked(cfg); err != nil {
		// Intent is not persisted on a failed bind: a machine that cannot
		// bind must come back disabled rather than retrying every boot.
		cfg.Enabled = false
		_ = s.store.SetPublishedSOCKS(cfg)
		return domain.PublishedSOCKSStatus{}, err
	}
	if err := s.store.SetPublishedSOCKS(cfg); err != nil {
		s.stopLocked()
		return domain.PublishedSOCKSStatus{}, err
	}
	return s.statusLocked(cfg), nil
}

// StartIfEnabled binds the stored config on boot. A failure is returned for
// the caller to log, never fatal: unlike the --socks5-addr flag (operator-typed
// at launch), this config is replayed automatically, so a since-taken port
// must not stop the server from starting.
func (s *PublishedSOCKSService) StartIfEnabled() error {
	cfg, err := s.store.PublishedSOCKS()
	if err != nil {
		return err
	}
	if !cfg.Enabled || cfg.Key == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bindLocked(cfg)
}

// Stop closes the listener without changing stored intent.
func (s *PublishedSOCKSService) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopLocked()
	return nil
}

func (s *PublishedSOCKSService) bindLocked(cfg domain.PublishedSOCKSConfig) error {
	if cfg.Key == "" {
		return fmt.Errorf("refusing to publish a SOCKS5 proxy without a key")
	}
	ln, err := net.Listen("tcp", ":"+strconv.Itoa(cfg.Port))
	if err != nil {
		return fmt.Errorf("port %d unavailable: %w", cfg.Port, err)
	}
	srv := netproxy.NewSOCKS5Server(cfg.Key)
	go func() {
		// Serve returns when the listener is closed by stopLocked, which is
		// an ordinary shutdown, not an error worth surfacing.
		_ = srv.Serve(ln)
	}()
	s.ln = ln
	s.running = cfg
	return nil
}

func (s *PublishedSOCKSService) stopLocked() {
	if s.ln != nil {
		_ = s.ln.Close()
		s.ln = nil
		s.running = domain.PublishedSOCKSConfig{}
	}
}
