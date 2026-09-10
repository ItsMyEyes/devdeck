//go:build !windows

package procgroup

import "os"

// Handle is a no-op everywhere but Windows: Unix callers already get
// whole-tree teardown from internal/terminal's own process-group signalling
// (see the package doc), so there is nothing for this package to add.
type Handle struct{}

// Attach is a no-op on this platform. The zero Handle it returns is always
// valid to call Terminate/Release on.
func Attach(*os.Process) (Handle, error) { return Handle{}, nil }

// Terminate does nothing on this platform.
func (Handle) Terminate() {}

// Release does nothing on this platform.
func (Handle) Release() {}
