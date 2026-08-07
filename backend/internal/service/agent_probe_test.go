package service

import (
	"testing"

	"devdeck/backend/internal/registry"
)

// newTestAgentService builds an AgentService backed by the same registry
// stack main.go wires when no Jadi backend is configured: StaticRegistry for
// the built-in catalogue, wrapped by LocalRegistry so Installed reflects
// this machine's own detect.ProbeAll(), matching how the real service is
// constructed.
func newTestAgentService(t *testing.T) *AgentService {
	t.Helper()
	return NewAgentService(registry.NewLocalRegistry(registry.NewStaticRegistry()))
}

// Every known agent must appear in the list whether or not it is installed —
// a missing binary is a status the UI renders, not an entry it omits.
func TestListAgentsIncludesUninstalledWithReason(t *testing.T) {
	svc := newTestAgentService(t)

	agents, err := svc.ListAgents()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(agents) == 0 {
		t.Fatal("no agents returned")
	}

	var sawUnavailable bool
	for _, a := range agents {
		if !a.Installed {
			sawUnavailable = true
			if a.Detail == "" {
				t.Errorf("agent %s is unavailable but gives no reason", a.ID)
			}
		}
	}
	if !sawUnavailable {
		t.Skip("every known agent is installed on this machine; nothing to assert")
	}
}
