package main

import (
	"net"
)

// advertisableHost turns the host half of a bound listen address into one
// another machine can actually dial.
//
// A listener bound to the unspecified address ("0.0.0.0", "::", or an empty
// host) reports exactly that back from Addr(), and "http://0.0.0.0:9199" is
// not a URL anything can reach — but that string is what a defaulted
// --public-url used to advertise to the hub during self-registration, so a
// runtime bound to all interfaces registered itself at an address the hub
// could never dial. Specific hosts are already dialable and pass through
// untouched.
//
// Returns "" when no routable address can be determined, leaving the caller
// to keep whatever it had.
func advertisableHost(host string) string {
	if host != "" && !net.ParseIP(host).IsUnspecified() {
		return host
	}
	return outboundIP()
}

// outboundIP reports the local address the OS would source traffic from,
// which is the interface a peer on the LAN would reach this machine on.
//
// UDP "dial" is a pure routing-table lookup — it is connectionless, so no
// packet is ever sent and the destination need not exist or be reachable.
// Falls back to scanning interfaces when there is no default route at all
// (offline, or a host with only link-local addressing).
func outboundIP() string {
	if conn, err := net.Dial("udp4", "8.8.8.8:80"); err == nil {
		defer conn.Close()
		if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok && addr.IP != nil {
			return addr.IP.String()
		}
	}
	return firstPrivateIPv4()
}

// firstPrivateIPv4 returns the first up, non-loopback IPv4 address on any
// interface. Ordering is whatever the OS reports, so this is a best-effort
// fallback rather than a considered choice of interface.
func firstPrivateIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			if ip4 := ipnet.IP.To4(); ip4 != nil && !ip4.IsLoopback() && !ip4.IsLinkLocalUnicast() {
				return ip4.String()
			}
		}
	}
	return ""
}

// advertiseURLFor builds the URL a peer should use to reach a listener bound
// at addr ("host:port" as reported by net.Listener.Addr). When the bind host
// is unspecified it is swapped for a routable one; if none can be found the
// original address is kept, which is no worse than the previous behavior.
func advertiseURLFor(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "http://" + addr
	}
	if resolved := advertisableHost(host); resolved != "" {
		host = resolved
	}
	return "http://" + net.JoinHostPort(host, port)
}
