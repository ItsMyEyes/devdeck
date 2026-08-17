package service

import (
	"context"
	"errors"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/sshtool"
)

type fakeRunner struct {
	gotCommand string
	stdout     string
	exitCode   int
}

func (f *fakeRunner) RunShell(_ context.Context, _, command string) ([]byte, []byte, int, error) {
	f.gotCommand = command
	return []byte(f.stdout), nil, f.exitCode, nil
}

type fakePolicy struct{ mode provider.RuntimeMode }

func (f fakePolicy) ModeFor(string) (provider.RuntimeMode, bool) { return f.mode, true }

type fakePrompter struct {
	asked    int
	decision event.Decision
	lastType event.RequestType
	session  bool
}

func (f *fakePrompter) Ask(_ context.Context, _, _ string, rt event.RequestType, _ string) (event.Decision, error) {
	f.asked++
	f.lastType = rt
	return f.decision, nil
}
func (f *fakePrompter) SessionAccepted(string) bool { return f.session }

func sess() sshtool.Session { return sshtool.Session{ThreadID: "ssh:c-1", ConnectionID: "c-1"} }

func TestExecReadOnlySkipsApprovalInAutoMode(t *testing.T) {
	r := &fakeRunner{stdout: "ok"}
	p := &fakePrompter{decision: event.DecisionAccept}
	svc := NewSSHToolService(r, nil, fakePolicy{provider.ModeAuto}, p)

	res, err := svc.Exec(context.Background(), sess(), "systemctl status nginx")
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if p.asked != 0 {
		t.Fatalf("asked for approval on a read-only command")
	}
	if res.Stdout != "ok" {
		t.Fatalf("stdout = %q", res.Stdout)
	}
}

func TestExecMutatingAsksAndRunsOnAccept(t *testing.T) {
	r := &fakeRunner{stdout: "restarted"}
	p := &fakePrompter{decision: event.DecisionAccept}
	svc := NewSSHToolService(r, nil, fakePolicy{provider.ModeAuto}, p)

	if _, err := svc.Exec(context.Background(), sess(), "systemctl restart nginx"); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if p.asked != 1 {
		t.Fatalf("asked %d times, want 1", p.asked)
	}
	if p.lastType != event.ReqCommandExecApproval {
		t.Fatalf("requestType = %q", p.lastType)
	}
	if r.gotCommand != "systemctl restart nginx" {
		t.Fatalf("command reached runner as %q", r.gotCommand)
	}
}

func TestExecDeniedNeverRuns(t *testing.T) {
	r := &fakeRunner{}
	p := &fakePrompter{decision: event.DecisionDecline}
	svc := NewSSHToolService(r, nil, fakePolicy{provider.ModeAuto}, p)

	if _, err := svc.Exec(context.Background(), sess(), "rm -rf /srv"); !errors.Is(err, ErrDenied) {
		t.Fatalf("err = %v, want ErrDenied", err)
	}
	if r.gotCommand != "" {
		t.Fatalf("denied command still ran: %q", r.gotCommand)
	}
}

func TestApprovalRequiredGatesEvenReads(t *testing.T) {
	p := &fakePrompter{decision: event.DecisionAccept}
	svc := NewSSHToolService(&fakeRunner{}, nil, fakePolicy{provider.ModeApprovalRequired}, p)

	if _, err := svc.Exec(context.Background(), sess(), "ls /etc"); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if p.asked != 1 {
		t.Fatalf("read was not gated in approval-required mode")
	}
}

func TestFullAccessNeverGates(t *testing.T) {
	p := &fakePrompter{decision: event.DecisionDecline}
	svc := NewSSHToolService(&fakeRunner{}, nil, fakePolicy{provider.ModeFullAccess}, p)

	if _, err := svc.Exec(context.Background(), sess(), "rm -rf /tmp/x"); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if p.asked != 0 {
		t.Fatalf("full-access mode asked for approval")
	}
}

func TestSessionAcceptSkipsRepeatApproval(t *testing.T) {
	p := &fakePrompter{decision: event.DecisionAccept, session: true}
	svc := NewSSHToolService(&fakeRunner{}, nil, fakePolicy{provider.ModeAuto}, p)

	if _, err := svc.Exec(context.Background(), sess(), "systemctl restart nginx"); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if p.asked != 0 {
		t.Fatalf("session-accepted thread was asked again")
	}
}

func TestNonZeroExitIsNotAnError(t *testing.T) {
	svc := NewSSHToolService(&fakeRunner{exitCode: 2}, nil, fakePolicy{provider.ModeFullAccess}, &fakePrompter{})
	res, err := svc.Exec(context.Background(), sess(), "ls /nope")
	if err != nil {
		t.Fatalf("non-zero exit surfaced as error: %v", err)
	}
	if res.ExitCode != 2 {
		t.Fatalf("exitCode = %d, want 2", res.ExitCode)
	}
}
