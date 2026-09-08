package service

import "testing"

func TestRuntimeBinderAdoptsFirstPush(t *testing.T) {
	var gotHubURL, gotMachineID string
	var syncStarted string
	b := NewRuntimeBinder("",
		func(hubURL, machineID string) { gotHubURL, gotMachineID = hubURL, machineID },
		func(hubURL string) { syncStarted = hubURL },
	)
	adopted, reason := b.Bind("https://hub.example.ts.net", "m-abc123")
	if !adopted {
		t.Fatalf("adopted = false, reason = %q, want true", reason)
	}
	if gotHubURL != "https://hub.example.ts.net" || gotMachineID != "m-abc123" {
		t.Errorf("onBind got (%q, %q), want (https://hub.example.ts.net, m-abc123)", gotHubURL, gotMachineID)
	}
	if syncStarted != "https://hub.example.ts.net" {
		t.Errorf("startSync called with %q, want https://hub.example.ts.net", syncStarted)
	}
}

func TestRuntimeBinderRefusesWhenExplicitHubURLConfigured(t *testing.T) {
	onBindCalls, startSyncCalls := 0, 0
	b := NewRuntimeBinder("https://operator-configured-hub.example.ts.net",
		func(string, string) { onBindCalls++ },
		func(string) { startSyncCalls++ },
	)
	adopted, reason := b.Bind("https://other-hub.example.ts.net", "m-abc123")
	if adopted {
		t.Fatal("adopted = true, want false: an explicit --hub-url must never be overridden by a push")
	}
	if reason == "" {
		t.Error("reason is empty, want an explanation")
	}
	if onBindCalls != 0 || startSyncCalls != 0 {
		t.Errorf("onBind/startSync called (%d, %d) times, want 0, 0", onBindCalls, startSyncCalls)
	}
}

func TestRuntimeBinderRejectsEmptyFields(t *testing.T) {
	b := NewRuntimeBinder("", func(string, string) {}, func(string) {})
	if adopted, _ := b.Bind("", "m-abc123"); adopted {
		t.Error("adopted = true with empty hubURL, want false")
	}
	if adopted, _ := b.Bind("https://hub.example.ts.net", ""); adopted {
		t.Error("adopted = true with empty machineID, want false")
	}
}

func TestRuntimeBinderRepeatPushSameHubIsNoop(t *testing.T) {
	onBindCalls, startSyncCalls := 0, 0
	b := NewRuntimeBinder("",
		func(string, string) { onBindCalls++ },
		func(string) { startSyncCalls++ },
	)
	for i := 0; i < 3; i++ {
		adopted, reason := b.Bind("https://hub.example.ts.net", "m-abc123")
		if !adopted {
			t.Fatalf("push %d: adopted = false, reason = %q", i, reason)
		}
	}
	// The hub re-pushes every cycle (RunBindingPushLoop); onBind/startSync
	// must run exactly once, not once per push, or a repeat push would spin
	// up a second concurrent sync loop applying snapshots against the same
	// store.
	if onBindCalls != 1 {
		t.Errorf("onBind called %d times across 3 identical pushes, want 1", onBindCalls)
	}
	if startSyncCalls != 1 {
		t.Errorf("startSync called %d times across 3 identical pushes, want 1", startSyncCalls)
	}
}

func TestRuntimeBinderRefusesReboundToDifferentHub(t *testing.T) {
	b := NewRuntimeBinder("", func(string, string) {}, func(string) {})
	if adopted, reason := b.Bind("https://hub-a.example.ts.net", "m-a"); !adopted {
		t.Fatalf("first bind failed: %q", reason)
	}
	adopted, reason := b.Bind("https://hub-b.example.ts.net", "m-b")
	if adopted {
		t.Fatal("adopted = true for a different hub while already bound, want false")
	}
	if reason == "" {
		t.Error("reason is empty, want an explanation")
	}
}
