package provider

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

type fakeConfig struct{}

func (fakeConfig) ProviderKind() Kind { return "fake" }

type fakeAdapter struct {
	id  InstanceID
	ch  chan event.Event
	rec []string
}

func (a *fakeAdapter) Kind() Kind                 { return "fake" }
func (a *fakeAdapter) InstanceID() InstanceID     { return a.id }
func (a *fakeAdapter) Capabilities() Capabilities { return Capabilities{} }
func (a *fakeAdapter) StartSession(context.Context, SessionStartInput) (Session, error) {
	return Session{}, nil
}
func (a *fakeAdapter) SendTurn(_ context.Context, in SendTurnInput) (TurnStartResult, error) {
	a.rec = append(a.rec, "send:"+in.Text)
	return TurnStartResult{TurnID: in.TurnID}, nil
}
func (a *fakeAdapter) InterruptTurn(context.Context, string, string) error { return nil }
func (a *fakeAdapter) RespondToRequest(context.Context, string, string, event.Decision) error {
	return nil
}
func (a *fakeAdapter) RespondToUserInput(context.Context, string, string, map[string]any) error {
	return nil
}
func (a *fakeAdapter) StopSession(context.Context, string) error { return nil }
func (a *fakeAdapter) StopAll(context.Context) error             { return nil }
func (a *fakeAdapter) HasSession(string) bool                    { return true }
func (a *fakeAdapter) ListSessions() []Session                   { return nil }
func (a *fakeAdapter) ReadThread(context.Context, string) (ThreadSnapshot, error) {
	return ThreadSnapshot{}, nil
}
func (a *fakeAdapter) RollbackThread(context.Context, string, int) (ThreadSnapshot, error) {
	return ThreadSnapshot{}, nil
}
func (a *fakeAdapter) Events() <-chan event.Event { return a.ch }

type fakeDriver struct{ created int }

func (d *fakeDriver) Kind() Kind                     { return "fake" }
func (d *fakeDriver) DefaultConfig() json.RawMessage { return json.RawMessage(`{}`) }
func (d *fakeDriver) DecodeConfig(json.RawMessage) (Config, error) {
	return fakeConfig{}, nil
}
func (d *fakeDriver) Probe(context.Context, Config) (Snapshot, error) {
	return Snapshot{Kind: "fake", Available: true, Version: "1.0.0"}, nil
}
func (d *fakeDriver) Create(_ context.Context, spec InstanceSpec) (Adapter, error) {
	d.created++
	return &fakeAdapter{id: spec.InstanceID, ch: make(chan event.Event)}, nil
}

type mapDirectory map[string]InstanceID

func (m mapDirectory) InstanceFor(threadID string) (InstanceID, bool) {
	id, ok := m[threadID]
	return id, ok
}
func (m mapDirectory) Bind(threadID string, id InstanceID) { m[threadID] = id }
func (m mapDirectory) Unbind(threadID string)              { delete(m, threadID) }

// Two instances of the same Kind must coexist — this is exactly the case that
// forced t3code's Kind->InstanceID migration.
func TestRegistryRoutesByInstanceNotKind(t *testing.T) {
	d := &fakeDriver{}
	r := NewRegistry(d)
	ctx := context.Background()

	if _, err := r.StartInstance(ctx, "fake", InstanceSpec{InstanceID: "fake:work"}); err != nil {
		t.Fatalf("start work: %v", err)
	}
	if _, err := r.StartInstance(ctx, "fake", InstanceSpec{InstanceID: "fake:personal"}); err != nil {
		t.Fatalf("start personal: %v", err)
	}
	if d.created != 2 {
		t.Fatalf("created = %d, want 2 distinct instances of one Kind", d.created)
	}

	a, err := r.Adapter("fake:personal")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if a.InstanceID() != "fake:personal" {
		t.Fatalf("routed to %s, want fake:personal", a.InstanceID())
	}
}

func TestRegistryUnknownDriver(t *testing.T) {
	r := NewRegistry()
	_, err := r.StartInstance(context.Background(), "nope", InstanceSpec{InstanceID: "nope:1"})
	if !errors.Is(err, ErrUnknownDriver) {
		t.Fatalf("err = %v, want ErrUnknownDriver", err)
	}
}

func TestServiceRoutesThreadToItsInstance(t *testing.T) {
	d := &fakeDriver{}
	r := NewRegistry(d)
	ctx := context.Background()
	if _, err := r.StartInstance(ctx, "fake", InstanceSpec{InstanceID: "fake:work"}); err != nil {
		t.Fatalf("start: %v", err)
	}

	svc := &Service{Registry: r, Dir: mapDirectory{"w-abc": "fake:work"}}
	if _, err := svc.SendTurn(ctx, SendTurnInput{ThreadID: "w-abc", Text: "hi"}); err != nil {
		t.Fatalf("send: %v", err)
	}

	// An unbound thread must fail loudly rather than silently pick an adapter.
	if _, err := svc.SendTurn(ctx, SendTurnInput{ThreadID: "w-unbound", Text: "hi"}); err == nil {
		t.Fatal("unbound thread should error")
	}
}
