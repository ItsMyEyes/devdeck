package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// slowPrompter models the only participant in this system that is not a
// computer: an operator who takes their time reading the command before
// answering it. Every test in this file exists because that pause used to be
// charged against the command's own budget.
type slowPrompter struct {
	delay   time.Duration
	asked   int
	session bool
}

func (p *slowPrompter) Ask(ctx context.Context, _, _ string, _ event.RequestType, _ string, _ bool) (event.Decision, error) {
	p.asked++
	select {
	case <-time.After(p.delay):
		return event.DecisionAccept, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (p *slowPrompter) SessionAccepted(string) bool { return p.session }

// The exec timeout bounds the remote command, never the human. Before this,
// the handler wrapped the whole call — approval included — in timeoutSec, so
// an operator who took longer than 60 seconds to answer got the command
// denied on their behalf and the agent was told the approval had timed out.
func TestExecTimeoutDoesNotBoundTheApprovalWait(t *testing.T) {
	runner := &fakeRunner{stdout: "restarted"}
	prompter := &slowPrompter{delay: 60 * time.Millisecond}
	svc := NewSSHToolService(runner, nil, fakePolicy{provider.ModeAuto}, prompter)

	// An exec budget an order of magnitude shorter than the operator takes.
	res, err := svc.Exec(context.Background(), sess(), "systemctl restart nginx", 10*time.Millisecond)
	if err != nil {
		t.Fatalf("Exec: %v (a slow approval must not spend the command's budget)", err)
	}
	if runner.gotCommand != "systemctl restart nginx" {
		t.Fatalf("command reached the runner as %q", runner.gotCommand)
	}
	if res.Stdout != "restarted" {
		t.Fatalf("stdout = %q", res.Stdout)
	}
}

// approval-required's pill reads "Ask before commands and file changes". A
// standing accept-for-session must not be able to switch that off.
func TestApprovalRequiredIgnoresAStandingSessionAccept(t *testing.T) {
	prompter := &slowPrompter{session: true}
	svc := NewSSHToolService(&fakeRunner{}, nil, fakePolicy{provider.ModeApprovalRequired}, prompter)

	if _, err := svc.Exec(context.Background(), sess(), "systemctl restart nginx", 0); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if prompter.asked != 1 {
		t.Fatalf("prompted %d times, want 1 — a session accept skipped approval-required", prompter.asked)
	}
}

// The session shortcut still works where it is meant to.
func TestAutoModeStillHonoursASessionAccept(t *testing.T) {
	prompter := &slowPrompter{session: true}
	svc := NewSSHToolService(&fakeRunner{}, nil, fakePolicy{provider.ModeAuto}, prompter)

	if _, err := svc.Exec(context.Background(), sess(), "systemctl restart nginx", 0); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if prompter.asked != 0 {
		t.Fatalf("prompted %d times, want 0 — auto mode ignored a session accept", prompter.asked)
	}
}

// An unanswered card is its own outcome, distinct from a transport deadline,
// so the handler can avoid telling the agent "the operator declined" when in
// fact the network failed.
func TestUnansweredApprovalReturnsErrApprovalTimeout(t *testing.T) {
	defer func(prev time.Duration) { approvalWindow = prev }(approvalWindow)
	approvalWindow = 10 * time.Millisecond

	runner := &fakeRunner{}
	svc := NewSSHToolService(runner, nil, fakePolicy{provider.ModeAuto}, &slowPrompter{delay: time.Hour})

	_, err := svc.Exec(context.Background(), sess(), "systemctl restart nginx", 0)
	if !errors.Is(err, ErrApprovalTimeout) {
		t.Fatalf("err = %v, want ErrApprovalTimeout", err)
	}
	if runner.gotCommand != "" {
		t.Fatalf("command ran despite an unanswered approval: %q", runner.gotCommand)
	}
}

// A caller that goes away (client disconnect) is not an approval timeout —
// it is the caller's own cancellation, and must surface as such.
func TestCallerCancellationIsNotAnApprovalTimeout(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	svc := NewSSHToolService(&fakeRunner{}, nil, fakePolicy{provider.ModeAuto}, &slowPrompter{delay: time.Hour})

	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()

	_, err := svc.Exec(ctx, sess(), "systemctl restart nginx", 0)
	if errors.Is(err, ErrApprovalTimeout) {
		t.Fatal("a cancelled caller was reported as an approval timeout")
	}
	if err == nil {
		t.Fatal("want an error from a cancelled caller")
	}
}
