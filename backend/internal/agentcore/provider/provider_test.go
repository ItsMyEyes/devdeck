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
func (a *fakeAdapter) SetInteractionMode(context.Context, string, InteractionMode) error {
	return nil
}
func (a *fakeAdapter) SetRuntimeMode(context.Context, string, RuntimeMode) error {
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

// The Reactor answers a user-input request through the Service, so the Service
// has to resolve the thread to its own instance the same way every other call
// does. Routing this to the wrong adapter would answer a question the agent
// behind it never asked.
func TestServiceRoutesUserInputResponseToItsInstance(t *testing.T) {
	d := &fakeDriver{}
	r := NewRegistry(d)
	ctx := context.Background()
	if _, err := r.StartInstance(ctx, "fake", InstanceSpec{InstanceID: "fake:work"}); err != nil {
		t.Fatalf("start: %v", err)
	}

	svc := &Service{Registry: r, Dir: mapDirectory{"w-abc": "fake:work"}}
	if err := svc.RespondToUserInput(ctx, "w-abc", "req-1", map[string]any{"q": "a"}); err != nil {
		t.Fatalf("respond: %v", err)
	}

	if err := svc.RespondToUserInput(ctx, "w-unbound", "req-1", nil); err == nil {
		t.Fatal("unbound thread should error")
	}
}

// Attachment must carry the same JSON-tag discipline as ModelSelection
// (provider.go:150-154's own comment): this is decoded straight off the
// WebSocket as part of TurnStartPayload, and an untagged struct would send
// PascalCase keys the client never emits, silently dropping every field.
func TestAttachmentJSONRoundTrip(t *testing.T) {
	in := Attachment{ID: "a-1", Kind: "image", MIME: "image/png", Name: "x.png"}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal to map: %v", err)
	}
	wantKeys := map[string]bool{"id": true, "kind": true, "mime": true, "name": true}
	if len(m) != len(wantKeys) {
		t.Fatalf("keys = %v, want exactly %v", m, wantKeys)
	}
	for k := range wantKeys {
		if _, ok := m[k]; !ok {
			t.Fatalf("marshaled output %s missing key %q", b, k)
		}
	}
	if _, ok := m["Data"]; ok {
		t.Fatalf("marshaled output %s must not include Data", b)
	}
	if _, ok := m["Path"]; ok {
		t.Fatalf("marshaled output %s must not include Path", b)
	}

	var out Attachment
	if err := json.Unmarshal([]byte(`{"id":"a-1","kind":"image","mime":"image/png","name":"x.png"}`), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.ID != "a-1" || out.Kind != "image" || out.MIME != "image/png" || out.Name != "x.png" {
		t.Fatalf("unmarshal = %+v, want id/kind/mime/name populated", out)
	}
}
