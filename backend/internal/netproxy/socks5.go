// Package netproxy implements generic SOCKS5 and HTTP forward-proxy
// servers for the app's own outbound networking needs — e.g. letting a
// real browser route its traffic through the Loom backend to reach a
// dev server on a remote runtime machine. It is not a security or
// anonymization tool.
package netproxy

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

const (
	socks5Version = 0x05

	socksMethodNoAuth       = 0x00
	socksMethodUserPass     = 0x02
	socksMethodNoAcceptable = 0xff

	socksCmdConnect = 0x01

	socksAtypIPv4   = 0x01
	socksAtypDomain = 0x03
	socksAtypIPv6   = 0x04

	socksRepSucceeded          = 0x00
	socksRepGeneralFailure     = 0x01
	socksRepNetworkUnreachable = 0x03
	socksRepHostUnreachable    = 0x04
	socksRepConnRefused        = 0x05
	socksRepCmdNotSupported    = 0x07
	socksRepAtypNotSupported   = 0x08

	userPassAuthVersion = 0x01
)

// SOCKS5Server is a minimal RFC 1928 SOCKS5 proxy: CONNECT only, no BIND
// or UDP ASSOCIATE. When authKey is non-empty, clients must complete RFC
// 1929 username/password negotiation with authKey as the password (any
// username is accepted).
type SOCKS5Server struct {
	authKey string
	dialer  net.Dialer
}

func NewSOCKS5Server(authKey string) *SOCKS5Server {
	return &SOCKS5Server{authKey: authKey, dialer: net.Dialer{Timeout: 10 * time.Second}}
}

func (s *SOCKS5Server) ListenAndServe(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	return s.Serve(ln)
}

func (s *SOCKS5Server) Serve(ln net.Listener) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		go s.handleConn(conn)
	}
}

func (s *SOCKS5Server) handleConn(conn net.Conn) {
	defer conn.Close()
	// Handshake must complete quickly; the deadline is lifted once the
	// tunnel is established so long-lived transfers aren't cut off.
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	r := bufio.NewReader(conn)

	if err := s.negotiate(r, conn); err != nil {
		return
	}

	target, err := s.readRequest(r, conn)
	if err != nil {
		return
	}

	_ = conn.SetDeadline(time.Time{})

	upstream, dialErr := s.dialer.Dial("tcp", target)
	if dialErr != nil {
		_ = writeSocksReply(conn, socksReplyCodeFor(dialErr))
		return
	}
	defer upstream.Close()

	if err := writeSocksReply(conn, socksRepSucceeded); err != nil {
		return
	}

	relay(conn, upstream)
}

func (s *SOCKS5Server) negotiate(r *bufio.Reader, w io.Writer) error {
	header := make([]byte, 2)
	if _, err := io.ReadFull(r, header); err != nil {
		return err
	}
	if header[0] != socks5Version {
		return fmt.Errorf("unsupported socks version %d", header[0])
	}
	methods := make([]byte, header[1])
	if _, err := io.ReadFull(r, methods); err != nil {
		return err
	}

	want := byte(socksMethodNoAuth)
	if s.authKey != "" {
		want = socksMethodUserPass
	}
	selected := byte(socksMethodNoAcceptable)
	for _, m := range methods {
		if m == want {
			selected = want
			break
		}
	}
	if _, err := w.Write([]byte{socks5Version, selected}); err != nil {
		return err
	}
	if selected != want {
		return fmt.Errorf("no acceptable auth method")
	}

	if want == socksMethodUserPass {
		return s.authenticate(r, w)
	}
	return nil
}

func (s *SOCKS5Server) authenticate(r *bufio.Reader, w io.Writer) error {
	verBuf := make([]byte, 1)
	if _, err := io.ReadFull(r, verBuf); err != nil {
		return err
	}
	if verBuf[0] != userPassAuthVersion {
		return fmt.Errorf("unsupported auth version %d", verBuf[0])
	}
	ulen := make([]byte, 1)
	if _, err := io.ReadFull(r, ulen); err != nil {
		return err
	}
	if _, err := io.CopyN(io.Discard, r, int64(ulen[0])); err != nil {
		return err
	}
	plen := make([]byte, 1)
	if _, err := io.ReadFull(r, plen); err != nil {
		return err
	}
	password := make([]byte, plen[0])
	if _, err := io.ReadFull(r, password); err != nil {
		return err
	}

	ok := string(password) == s.authKey
	status := byte(0x00)
	if !ok {
		status = 0x01
	}
	if _, err := w.Write([]byte{userPassAuthVersion, status}); err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("invalid socks5 credentials")
	}
	return nil
}

func (s *SOCKS5Server) readRequest(r *bufio.Reader, w io.Writer) (string, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(r, header); err != nil {
		return "", err
	}
	if header[0] != socks5Version {
		return "", fmt.Errorf("unsupported socks version %d", header[0])
	}
	cmd, atyp := header[1], header[3]
	if cmd != socksCmdConnect {
		_ = writeSocksReply(w, socksRepCmdNotSupported)
		return "", fmt.Errorf("unsupported command %d", cmd)
	}

	host, err := readSocksAddress(r, atyp)
	if err != nil {
		_ = writeSocksReply(w, socksRepAtypNotSupported)
		return "", err
	}
	portBuf := make([]byte, 2)
	if _, err := io.ReadFull(r, portBuf); err != nil {
		return "", err
	}
	port := binary.BigEndian.Uint16(portBuf)
	return net.JoinHostPort(host, strconv.Itoa(int(port))), nil
}

func readSocksAddress(r *bufio.Reader, atyp byte) (string, error) {
	switch atyp {
	case socksAtypIPv4:
		buf := make([]byte, 4)
		if _, err := io.ReadFull(r, buf); err != nil {
			return "", err
		}
		return net.IP(buf).String(), nil
	case socksAtypIPv6:
		buf := make([]byte, 16)
		if _, err := io.ReadFull(r, buf); err != nil {
			return "", err
		}
		return net.IP(buf).String(), nil
	case socksAtypDomain:
		lenBuf := make([]byte, 1)
		if _, err := io.ReadFull(r, lenBuf); err != nil {
			return "", err
		}
		buf := make([]byte, lenBuf[0])
		if _, err := io.ReadFull(r, buf); err != nil {
			return "", err
		}
		return string(buf), nil
	default:
		return "", fmt.Errorf("unsupported address type %d", atyp)
	}
}

func writeSocksReply(w io.Writer, code byte) error {
	// BND.ADDR/BND.PORT are zeroed; CONNECT-only clients don't rely on them.
	reply := []byte{socks5Version, code, 0x00, socksAtypIPv4, 0, 0, 0, 0, 0, 0}
	_, err := w.Write(reply)
	return err
}

func socksReplyCodeFor(err error) byte {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "refused"):
		return socksRepConnRefused
	case strings.Contains(msg, "no such host"), strings.Contains(msg, "not found"):
		return socksRepHostUnreachable
	case strings.Contains(msg, "network is unreachable"):
		return socksRepNetworkUnreachable
	default:
		return socksRepGeneralFailure
	}
}

// relay pipes data between two established connections until either side
// closes, half-closing the write side of each so a one-directional EOF
// (e.g. an HTTP client done sending) doesn't stall the other direction.
func relay(a, b net.Conn) {
	done := make(chan struct{}, 2)
	pipe := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
		done <- struct{}{}
	}
	go pipe(a, b)
	go pipe(b, a)
	<-done
	<-done
}
