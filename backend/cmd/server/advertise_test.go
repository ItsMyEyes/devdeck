package main

import (
	"net"
	"strings"
	"testing"
)

func TestAdvertisableHostPassesThroughSpecificAddresses(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "192.168.1.24", "10.0.0.5", "::1"} {
		if got := advertisableHost(host); got != host {
			t.Errorf("advertisableHost(%q) = %q, want it unchanged", host, got)
		}
	}
}

// The regression: a listener bound to all interfaces reports the unspecified
// address back from Addr(), and advertising "http://0.0.0.0:<port>" to the
// hub registers the runtime at an address nothing can dial.
func TestAdvertisableHostReplacesUnspecified(t *testing.T) {
	for _, host := range []string{"0.0.0.0", "::", ""} {
		got := advertisableHost(host)
		if got == host || got == "0.0.0.0" || got == "::" {
			t.Errorf("advertisableHost(%q) = %q, want a routable address", host, got)
			continue
		}
		if got == "" {
			t.Skipf("no routable address on this host; nothing to assert for %q", host)
		}
		if ip := net.ParseIP(got); ip == nil || ip.IsUnspecified() {
			t.Errorf("advertisableHost(%q) = %q, want a parseable non-unspecified IP", host, got)
		}
	}
}

func TestAdvertiseURLForKeepsPort(t *testing.T) {
	got := advertiseURLFor("0.0.0.0:9199")
	if !strings.HasSuffix(got, ":9199") {
		t.Fatalf("advertiseURLFor(0.0.0.0:9199) = %q, want the port preserved", got)
	}
	if strings.Contains(got, "0.0.0.0") {
		t.Fatalf("advertiseURLFor(0.0.0.0:9199) = %q, want the unspecified host replaced", got)
	}
}

func TestAdvertiseURLForLeavesSpecificHostAlone(t *testing.T) {
	if got := advertiseURLFor("192.168.1.24:9199"); got != "http://192.168.1.24:9199" {
		t.Fatalf("got %q, want http://192.168.1.24:9199", got)
	}
	if got := advertiseURLFor("127.0.0.1:8989"); got != "http://127.0.0.1:8989" {
		t.Fatalf("got %q, want http://127.0.0.1:8989", got)
	}
}

// Malformed input must not panic or drop the address entirely — callers use
// the result verbatim as a URL.
func TestAdvertiseURLForToleratesUnsplittableAddr(t *testing.T) {
	if got := advertiseURLFor("not-a-host-port"); got != "http://not-a-host-port" {
		t.Fatalf("got %q, want the address passed through", got)
	}
}
