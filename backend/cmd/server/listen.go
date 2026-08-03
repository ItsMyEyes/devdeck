package main

import (
	"fmt"
	"log"
	"net"
	"time"
)

// listenRetryWindow is how long a starting server waits for a listen address
// that is still held by the process it is replacing.
//
// A restart is a handoff between two overlapping processes: POST
// /api/self/restart spawns the replacement first and only then exits (see
// internal/handler/self.go), and under --managed the desktop supervisor owns
// the respawn entirely, so devdeck cannot order the two at all. Either way the
// outgoing listener can still be bound when the incoming process reaches its
// own bind. That conflict is transient, but it is fatal on Windows in
// particular, where Go deliberately leaves SO_REUSEADDR off listening sockets
// (net/sockopt_windows.go) and the bind fails outright with "Only one usage of
// each socket address (protocol/network address/port) is normally permitted".
// Exiting on it turns every restart into a coin flip that can leave nothing
// listening at all, so the incoming process waits the overlap out instead.
const listenRetryWindow = 10 * time.Second

// listenRetryInterval is how often the incoming process re-attempts the bind
// while the outgoing one is still shutting down.
const listenRetryInterval = 100 * time.Millisecond

// listenWithRetry binds addr, retrying for up to window while the address is
// still in use. Only an address conflict is retried: every other bind error (a
// malformed address, a port this user may not open) is permanent, and stalling
// startup on those would bury the real reason under a ten-second pause.
func listenWithRetry(network, addr string, window time.Duration) (net.Listener, error) {
	deadline := time.Now().Add(window)
	warned := false
	for {
		l, err := net.Listen(network, addr)
		if err == nil {
			if warned {
				log.Printf("listen: %s was released; continuing startup", addr)
			}
			return l, nil
		}
		if !isAddrInUse(err) {
			return nil, err
		}
		if !time.Now().Before(deadline) {
			return nil, fmt.Errorf("%s is still in use %s after startup began: %w (is another devdeck already running on this port?)", addr, window, err)
		}
		if !warned {
			log.Printf("listen: %s is still in use, waiting up to %s for the previous instance to release it", addr, window)
			warned = true
		}
		time.Sleep(listenRetryInterval)
	}
}
