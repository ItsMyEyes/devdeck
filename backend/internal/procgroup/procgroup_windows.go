//go:build windows

package procgroup

import (
	"fmt"
	"os"
	"runtime"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Handle is a Windows Job Object holding one process. Windows automatically
// enrolls every further process a job member spawns into the same job
// (unless the job explicitly opts into breakaway, which this one does not),
// so assigning just the process this package was handed is enough to cover
// its whole descendant tree.
//
// A session's Terminate (from an explicit kill) and Release (from the
// process exiting on its own) race each other by design — see
// internal/terminal/registry.go's spawn/kill. Handle is a plain value copied
// into both call sites, so the once-guard has to live behind the pointer
// both copies share, not on Handle itself: whichever call lands first runs,
// the other becomes a no-op, and the job object's single OS handle is closed
// exactly once either way.
type Handle struct {
	state *handleState
}

type handleState struct {
	job  windows.Handle
	once sync.Once
}

// Attach creates a job object configured to kill every process it still
// holds the instant the job's last handle closes, and assigns proc to it.
//
// Best-effort: an error here must never fail the caller's spawn — it only
// means that one process falls back to plain, non-tree-aware termination,
// exactly like before this package existed.
//
// Assignment happens immediately after the caller's Start() returns, before
// this goroutine yields — the same timing every job-object-based
// process-tree killer on Windows relies on, short of starting the process
// suspended (not exposed by the go-pty command this backend spawns through).
// A child spawning its own grandchild before the assignment lands is not
// impossible, but takes at least a full scheduler quantum longer than this
// function does, so it is not a realistic race in practice.
func Attach(proc *os.Process) (Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return Handle{}, fmt.Errorf("procgroup: create job object: %w", err)
	}

	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	// SetInformationJobObject takes the struct as a bare uintptr, so the
	// unsafe.Pointer -> uintptr conversion happens here rather than inside a
	// syscall argument list. That is outside the one pattern the unsafe rules
	// bless, and a uintptr does not keep its referent alive: without the
	// KeepAlive below, info is unreachable the instant its address is taken
	// and may be collected before the syscall reads it.
	_, err = windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
	runtime.KeepAlive(&info)
	if err != nil {
		_ = windows.CloseHandle(job)
		return Handle{}, fmt.Errorf("procgroup: configure job object: %w", err)
	}

	// AssignProcessToJobObject needs a handle opened with PROCESS_SET_QUOTA |
	// PROCESS_TERMINATE, which proc's own internal handle isn't (Process.
	// WithHandle would hand out the real one race-free, but needs Go 1.26;
	// this module targets 1.25). Opening a fresh one by pid is safe here
	// specifically because this runs immediately after the caller's Start()
	// returns: proc is still alive, nothing has called Wait or Release on it
	// yet, and Windows will not recycle a pid while any handle to that
	// process — including the one Start() itself is still holding — remains
	// open.
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(proc.Pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return Handle{}, fmt.Errorf("procgroup: open process %d: %w", proc.Pid, err)
	}
	defer windows.CloseHandle(handle)

	if err := windows.AssignProcessToJobObject(job, handle); err != nil {
		_ = windows.CloseHandle(job)
		return Handle{}, fmt.Errorf("procgroup: assign process to job object: %w", err)
	}

	return Handle{state: &handleState{job: job}}, nil
}

// Terminate kills every process still in the group. A no-op if Release
// already ran first (the process exited on its own before this was called).
func (h Handle) Terminate() {
	if h.state == nil {
		return
	}
	h.state.once.Do(func() {
		_ = windows.TerminateJobObject(h.state.job, 1)
		_ = windows.CloseHandle(h.state.job)
	})
}

// Release closes the job's OS handle so it doesn't leak, and is what a caller
// uses once the process it handed to Attach has already exited on its own.
//
// It is NOT a detach: this job carries JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so
// closing its last handle terminates whatever is still assigned to it. When
// the caller's own process has exited that set is normally empty and Release
// is exactly the cheap cleanup it looks like — but a descendant that outlived
// its parent is killed here rather than left behind, which is the whole point
// of the package. Use Terminate when the kill is the intent; the two differ
// only in whether the kill is also requested explicitly.
//
// A no-op if Terminate already ran first.
func (h Handle) Release() {
	if h.state == nil {
		return
	}
	h.state.once.Do(func() {
		_ = windows.CloseHandle(h.state.job)
	})
}
