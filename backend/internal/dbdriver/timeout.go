package dbdriver

import (
	"context"
	"time"
)

// DefaultStatementTimeout bounds any single statement. Without it, one
// pathological query holds a pooled connection indefinitely.
const DefaultStatementTimeout = 30 * time.Second

// WithStatementTimeout derives a context bounded by d, or by
// DefaultStatementTimeout when d is zero or negative.
//
// Deriving from ctx (rather than context.Background) is what makes request
// cancellation propagate: when the browser closes the tab, the HTTP request
// context cancels and the in-flight query is killed instead of running on.
func WithStatementTimeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if d <= 0 {
		d = DefaultStatementTimeout
	}
	return context.WithTimeout(ctx, d)
}
