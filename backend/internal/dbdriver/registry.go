// Package dbdriver holds per-engine implementations of port.DBDriver and a
// registry mapping engine names to them.
package dbdriver

import (
	"fmt"
	"sync"

	"devdeck/backend/internal/port"
)

var (
	mu      sync.RWMutex
	drivers = map[string]port.DBDriver{}
)

// Register makes a driver available under an engine name. Called from main.go
// during wiring, not from init(), so the set of enabled engines stays explicit.
func Register(engine string, d port.DBDriver) {
	mu.Lock()
	defer mu.Unlock()
	drivers[engine] = d
}

// Get returns the driver for an engine.
func Get(engine string) (port.DBDriver, error) {
	mu.RLock()
	defer mu.RUnlock()
	d, ok := drivers[engine]
	if !ok {
		return nil, fmt.Errorf("no driver registered for engine %q", engine)
	}
	return d, nil
}

// AllCaps returns every registered engine's capabilities, served to the
// frontend by GET /api/db/engines.
func AllCaps() map[string]port.DBCaps {
	mu.RLock()
	defer mu.RUnlock()
	out := map[string]port.DBCaps{}
	for name, d := range drivers {
		out[name] = d.Capabilities()
	}
	return out
}
