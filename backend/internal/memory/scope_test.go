package memory

import (
	"reflect"
	"testing"
	"time"
)

func TestScopeTagsSortedAndSlugified(t *testing.T) {
	s := Scope{Project: "Acme Corp / Billing", Machine: "Mac Mini", Provider: "claude", Surface: "worktree"}
	got := s.Tags()
	want := []string{"machine:mac-mini", "project:acme-corp-billing", "provider:claude", "surface:worktree"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Tags() = %v, want %v", got, want)
	}
}

func TestScopeTagsSkipsEmptyFields(t *testing.T) {
	s := Scope{Project: "demo"}
	got := s.Tags()
	want := []string{"project:demo"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Tags() = %v, want %v", got, want)
	}
}

func TestRecallTagsScopesToProjectPlusGlobal(t *testing.T) {
	// A worktree chat on "Acme Corp / Billing" must recall its own project's
	// facts and the global tier — and nothing else. The project tag is
	// slugified exactly as Scope.Tags renders it, so it lines up with what was
	// stored.
	tags, match := RecallTags(Scope{Project: "Acme Corp / Billing", Surface: "worktree"})
	want := []string{"project:acme-corp-billing", "scope:global"}
	if !reflect.DeepEqual(tags, want) {
		t.Fatalf("tags = %v, want %v", tags, want)
	}
	if match != "any" {
		t.Fatalf("match = %q, want any", match)
	}
}

func TestRecallTagsFallsBackToSurfaceWhenNoProject(t *testing.T) {
	// An SSH DevOps thread with no project name must stay scoped to its surface
	// plus global — not fall through to the whole bank.
	tags, match := RecallTags(Scope{Surface: "ssh"})
	want := []string{"scope:global", "surface:ssh"}
	if !reflect.DeepEqual(tags, want) {
		t.Fatalf("tags = %v, want %v", tags, want)
	}
	if match != "any" {
		t.Fatalf("match = %q, want any", match)
	}
}

func TestRecallTagsNeverEmptyEvenWithBareScope(t *testing.T) {
	// The one invariant that matters: RecallTags must never return an empty
	// filter, because an empty filter is the whole-bank bleed it exists to
	// stop. A scope with no project and no surface still scopes to the global
	// tier alone.
	tags, match := RecallTags(Scope{})
	want := []string{"scope:global"}
	if !reflect.DeepEqual(tags, want) {
		t.Fatalf("tags = %v, want %v", tags, want)
	}
	if match != "any" {
		t.Fatalf("match = %q, want any", match)
	}
}

func TestFormatRecallEmptyResultsYieldsEmptyString(t *testing.T) {
	if got := FormatRecall(nil, time.Now()); got != "" {
		t.Fatalf("FormatRecall(nil) = %q, want empty", got)
	}
}

func TestFormatRecallIncludesTextAndType(t *testing.T) {
	now := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	block := FormatRecall([]RecallResult{
		{Text: "prefers tabs over spaces", Type: "world", MentionedAt: "2026-08-10T00:00:00Z"},
	}, now)
	if block == "" {
		t.Fatal("expected non-empty block")
	}
	for _, want := range []string{"<memories>", "prefers tabs over spaces", "[world]", "2026-08-10", "</memories>"} {
		if !contains(block, want) {
			t.Fatalf("block missing %q:\n%s", want, block)
		}
	}
}

func TestPrependEmptyBlockReturnsTextUnchanged(t *testing.T) {
	if got := Prepend("", "hello"); got != "hello" {
		t.Fatalf("Prepend empty block = %q", got)
	}
}

func TestPrependJoinsBlockAndText(t *testing.T) {
	got := Prepend("<memories>x</memories>", "hello")
	if !contains(got, "hello") || !contains(got, "memories") {
		t.Fatalf("Prepend = %q", got)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && indexOf(s, sub) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
