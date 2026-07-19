package dbdriver

import (
	"context"
	"testing"
	"time"
)

func TestWithStatementTimeoutAppliesDefault(t *testing.T) {
	ctx, cancel := WithStatementTimeout(context.Background(), 0)
	defer cancel()
	dl, ok := ctx.Deadline()
	if !ok {
		t.Fatal("no deadline set")
	}
	if remaining := time.Until(dl); remaining > DefaultStatementTimeout+time.Second {
		t.Fatalf("deadline %v exceeds default %v", remaining, DefaultStatementTimeout)
	}
}

func TestWithStatementTimeoutPreservesEarlierParentDeadline(t *testing.T) {
	// A cancelled request must abort the query even when the statement
	// timeout is longer; abandoned queries otherwise pin runtime connections.
	parent, cancelParent := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancelParent()
	ctx, cancel := WithStatementTimeout(parent, time.Hour)
	defer cancel()

	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("child context outlived its parent's deadline")
	}
}
