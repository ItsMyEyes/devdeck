//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package service

import (
	"errors"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// TestWorktreeFileServiceDownloadRejectsNonRegularFiles guards the handler
// goroutine: os.Open on a FIFO blocks until a writer opens the other end, and
// the server runs on a bare http.Serve with no WriteTimeout, so one such
// request would wedge a goroutine for the process lifetime.
func TestWorktreeFileServiceDownloadRejectsNonRegularFiles(t *testing.T) {
	svc, worktreeID, root := newDownloadTestWorktree(t)
	if err := syscall.Mkfifo(filepath.Join(root, "pipe"), 0o644); err != nil {
		t.Skipf("mkfifo is unavailable here: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		file, _, _, err := svc.Download(worktreeID, "pipe")
		if file != nil {
			file.Close()
		}
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, ErrValidation) {
			t.Errorf("Download of a FIFO error = %v, want ErrValidation", err)
		}
	case <-time.After(5 * time.Second):
		// Not t.Fatal from the test goroutine's perspective only: the blocked
		// Download goroutine stays parked for the rest of the run, which is
		// exactly the leak being asserted against.
		t.Fatal("Download of a FIFO blocked instead of returning ErrValidation")
	}
}
